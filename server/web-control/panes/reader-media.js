/* Native session output images. Only opaque DTO ids reach the content route; markdown and paths are never sources. */
(function () {
  'use strict';
  var W = window.COSWeb;
  if (!W) return;
  var scopes = new Map(), viewer = null, requests = [], activeRequests = 0;
  var ID = /^ai_[a-f0-9]{64}$/, TOOL_ID = /^ti_[a-f0-9]{64}$/;
  var TOOLS = ['Read', 'Screenshot', 'Image', 'Attached'];
  // outside_workspace and missing are permanent. unavailable means the workspace lookup failed this time; the content route
  // re-resolves it. 6.99.35: outside the workspace and missing (a file a session sent that is gone) read the same, with no path.
  var REASONS = { outside_workspace: 'Not available on this Mac.', missing: 'Not available on this Mac.',
    secret_file: 'Not shown: this file may hold secrets.', unavailable: 'This image is temporarily unavailable. Retry in a moment.', too_large: 'Too large to show here.' };
  var style = document.createElement('style');
  style.textContent = '.rm-item{display:flex;flex-direction:column;gap:6px;max-width:180px}.rm-label,.rm-status{font:12px/1.4 var(--body);color:var(--sub);overflow-wrap:anywhere}.rm-label{color:var(--text)}.rm-item .cx-thumb{cursor:pointer}.rm-view{position:fixed;inset:0;z-index:10000;background:var(--bg,#171717);color:var(--text,#fff);display:flex;flex-direction:column;padding: max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));gap:16px}.rm-view-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.rm-view-label{margin:0;overflow-wrap:anywhere;font:16px/1.4 var(--body)}.rm-view-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}.rm-view img{max-width:100%;max-height:100%;object-fit:contain}.rm-viewing{overflow:hidden!important}.rm-files{display:flex;flex-direction:column;gap:8px;margin-top:10px}.rm-file{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:10px 12px;border:1px solid var(--panel-border);border-radius:12px;background:var(--panel);max-width:560px}.rm-file-icon{grid-row:1/span 2;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;background:var(--bg);border:1px solid var(--panel-border);font:600 11px/1 var(--body);letter-spacing:.04em;color:var(--sub)}.rm-file-name{font:500 14px/1.35 var(--body);color:var(--text);overflow-wrap:anywhere;min-width:0}.rm-file-meta{font:12px/1.4 var(--body);color:var(--sub);grid-column:2;min-width:0}.rm-file-acts{grid-column:3;grid-row:1/span 2;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.rm-file-acts .cx-btn{min-height:44px}.rm-file .rm-status{grid-column:1/-1}.rm-file.off{opacity:.78}.rm-view-acts{display:flex;gap:8px;align-items:center}.rm-text{flex:1;min-height:0;width:100%;overflow:auto;margin:0;padding:12px;border:1px solid var(--panel-border);border-radius:10px;background:var(--panel);color:var(--ink);font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.rm-frame{flex:1;min-height:0;width:100%;border:1px solid var(--panel-border);border-radius:10px;background:#fff}.rm-tools{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0 2px;align-items:flex-start}.rm-tools.before{margin:2px 0 10px}.rm-tool{display:flex;flex-direction:column;gap:4px;width:132px;min-width:0}.rm-tool-thumb{display:flex;align-items:center;justify-content:center;width:132px;height:88px;padding:0;overflow:hidden;border:1px solid var(--panel-border);border-radius:10px;background:var(--panel);color:var(--sub);font:12px/1.3 var(--body);cursor:pointer;text-align:center}.rm-tool-thumb:disabled{cursor:default}.rm-tool-thumb:focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:2px}.rm-tool-thumb img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}.rm-tool-cap{display:flex;justify-content:space-between;gap:6px;font:12px/1.3 var(--body);min-width:0}.rm-tool-name{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rm-tool-pos{color:var(--sub);white-space:nowrap}.rm-tool .rm-status{font-size:11.5px}.rm-tool-more{display:flex;align-items:center;justify-content:center;width:88px;height:88px;border:1px dashed var(--panel-border);border-radius:10px;color:var(--sub);font:13px/1.3 var(--body)}@media (max-width:599px){.rm-tool{width:104px}.rm-tool-thumb{width:104px;height:72px}.rm-tool-more{width:72px;height:72px}}@media (max-width:599px){.rm-file{grid-template-columns:40px minmax(0,1fr)}.rm-file-icon{width:40px;height:40px}.rm-file-acts{grid-column:1/-1;grid-row:auto;justify-content:flex-start}}';
  document.head.appendChild(style);

  function element(tag, cls, text) {
    var el = document.createElement(tag); if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function button(text, action, cls) {
    var b = element('button', cls || 'cx-btn quiet', text); b.type = 'button'; b.addEventListener('click', action); return b;
  }
  function path(scope, id, variant) {
    // A tool-result or prompt image has one size; the thumbnail is the same bytes drawn small, fetched only when seen.
    if (TOOL_ID.test(id)) return '/api/agent-sessions/' + encodeURIComponent(scope.provider) + '/' + encodeURIComponent(scope.id) + '/tool-images/' + encodeURIComponent(id) + '/content';
    return '/api/agent-sessions/' + encodeURIComponent(scope.provider) + '/' + encodeURIComponent(scope.id) + '/output-images/' + encodeURIComponent(id) + '/content?variant=' + variant;
  }
  function revoke(item) { if (item.url) { URL.revokeObjectURL(item.url); item.url = ''; } }
  // 7.0.4 QA: a 503 previews_busy means the Mac is already reading its limit of previews. It is not unreachable.
  var BUSY_WORDS = 'Your Mac is busy with other previews. Try again in a moment.';
  function busy(err) { return !!(err && err.status === 503 && err.code === 'previews_busy'); }
  // A busy thumbnail tries again by itself, after 1, 2, 4 and 8 seconds (with a little spread), then waits for Retry.
  var BUSY_RETRIES = 4;
  function busyDelay(tries) { return 1000 * Math.pow(2, tries) + Math.floor(Math.random() * 250); }
  function failWords(err) {
    if (busy(err)) return BUSY_WORDS;
    if (err && err.status === 401) return 'Signed out. Connect this browser again to view the image.';
    if (err && err.status === 403 && err.code === 'secret_file_denied') return REASONS.secret_file;
    if (err && err.status === 403) return 'Previews are off. Turn them on in Settings, Privacy.';
    if (err && err.status === 404) return 'This image is no longer available. Reopen the session to refresh its images.';
    if (err && err.status === 413) return 'Too large to show here.';
    return 'The image could not load. Check that your Mac is awake, then retry.';
  }
  function retryable(err) { return !(err && (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 413)); }
  function imageBlob(blob) { return blob && /^image\/(png|jpeg|webp|gif|avif)$/.test(blob.type || '') && blob.size > 0; }
  // The server normalizes at most two images at once. Share that budget across both readers and the viewer.
  function pump() {
    while (activeRequests < 2 && requests.length) {
      var job = requests.shift();
      if (!job.valid()) { job.resolve(null); continue; }
      activeRequests++;
      (function (j) {
        // The strip can disappear between admission and this microtask.
        Promise.resolve().then(function () { return j.valid() ? j.run() : null; }).then(j.resolve, j.reject).then(function () { activeRequests--; pump(); });
      })(job);
    }
  }
  // type 'json' (preview engine phase 1): a text window or table page, parsed. Anything else is a blob.
  function imageRequest(url, valid, foreground, type) {
    return new Promise(function (resolve, reject) {
      var job = { valid: valid, resolve: resolve, reject: reject, run: function () { return W.api(url, type === 'json' ? { timeoutMs: 20000 } : { responseType: 'blob', timeoutMs: 20000 }); } };
      if (foreground) requests.unshift(job); else requests.push(job);
      pump();
    });
  }
  function fetchImage(scope, item, variant, target, ready, failed) {
    var generation = ++target.generation;
    imageRequest(path(scope, item.id, variant), function () { return scope.alive && target.active !== false && generation === target.generation; }, variant === 'phone').then(function (blob) {
      if (!scope.alive || target.active === false || generation !== target.generation) return;
      if (!imageBlob(blob)) throw new Error('Not a supported image');
      revoke(target); target.url = URL.createObjectURL(blob); ready(target.url);
    }).catch(function (err) {
      if (scope.alive && target.active !== false && generation === target.generation) failed(err);
    });
  }
  function loadThumb(scope, item) {
    if (!scope.alive || item.active === false || item.busy) return;
    item.busy = true; item.open.textContent = 'Loading image…'; item.status.textContent = 'Loading image…'; item.retry.hidden = true; item.open.disabled = true;
    fetchImage(scope, item, 'thumb', item, function (url) {
      item.busy = false; item.busyTries = 0; item.open.textContent = '';
      var img = element('img'); img.alt = item.label;
      img.addEventListener('error', function () {
        if (!scope.alive || item.active === false || item.url !== url) return;
        revoke(item); item.open.textContent = 'Image unavailable'; item.open.disabled = true;
        item.status.textContent = 'The image could not be displayed.'; item.retry.hidden = false;
      });
      img.src = url; item.open.appendChild(img); item.open.disabled = false; item.status.textContent = '';
    }, function (err) {
      item.busy = false; item.open.textContent = 'Image unavailable'; item.status.textContent = failWords(err); item.retry.hidden = !retryable(err);
      if (busy(err) && (item.busyTries || 0) < BUSY_RETRIES) {
        var delay = busyDelay(item.busyTries || 0);
        item.busyTries = (item.busyTries || 0) + 1;
        item.open.textContent = 'Waiting…'; item.status.textContent = 'Your Mac is busy with other previews. Trying again…'; item.retry.hidden = true;
        setTimeout(function () { if (scope.alive && item.active !== false && !item.url) loadThumb(scope, item); }, delay);
      }
    });
  }
  // Back closes the viewer and lands where you were (11/08). Opening one pushes a history entry on the same address
  // (no hashchange, so no pane changes); Back pops it and closes the image. Closing it any other way takes that entry
  // back off, quietly: its popstate is ours, and the wait lapses after POP_WAIT_MS so a later real Back is never eaten.
  var ownPops = 0, POP_WAIT_MS = 700;
  function pushEntry(v) {
    try { history.pushState(Object.assign({}, history.state || {}, { cosImageViewer: 1 }), ''); v.pushed = true; } catch (_e) { v.pushed = false; }
  }
  function dropEntry() {
    ownPops++;
    setTimeout(function () { if (ownPops > 0) ownPops--; }, POP_WAIT_MS);
    try { history.back(); } catch (_e) { ownPops--; }
  }
  // Another popstate listener (Today's sheet) may run before or after this one, so the event is marked as well.
  function mark(e) { try { if (e) e.__cosImagePop = true; } catch (_e) { /* a frozen event: popIsMine still sees the state */ } }
  window.addEventListener('popstate', function (e) {
    if (ownPops > 0) { ownPops--; mark(e); return; }
    if (viewer && viewer.pushed) { viewer.pushed = false; mark(e); closeViewer(); }
  });
  function popIsMine(e) { return !!(e && e.__cosImagePop) || ownPops > 0 || !!(viewer && viewer.pushed); }
  // The scroll spots under the opener: the page and every scrolled box it sits in (Today's sheet body).
  function scrollSpots(el) {
    var out = { x: window.scrollX || 0, y: window.scrollY || 0, boxes: [] };
    for (var p = el && el.parentElement; p; p = p.parentElement) if (p.scrollTop > 0) out.boxes.push([p, p.scrollTop]);
    return out;
  }
  function restoreSpots(spots) {
    if (!spots) return;
    spots.boxes.forEach(function (b) { if (b[0].scrollTop !== b[1]) b[0].scrollTop = b[1]; });
    if ((window.scrollX || 0) !== spots.x || (window.scrollY || 0) !== spots.y) { try { window.scrollTo(spots.x, spots.y); } catch (_e) {} }
  }
  // keepEntry: another viewer replaces this one and takes over its history entry.
  function closeViewer(restore, keepEntry) {
    var v = viewer; if (!v) return;
    viewer = null; v.generation++; revoke(v); if (v.unpin) v.unpin(); v.el.remove(); document.documentElement.classList.remove('rm-viewing');
    if (v.pushed && !keepEntry) { v.pushed = false; dropEntry(); }
    if (restore !== false && v.opener && v.opener.isConnected) { try { v.opener.focus({ preventScroll: true }); } catch (_e) { v.opener.focus(); } }
    if (restore !== false) restoreSpots(v.spots);
  }
  function takeOver(v, had) { v.spots = had ? had.spots : scrollSpots(v.opener); if (had && had.pushed) v.pushed = true; else pushEntry(v); pinViewer(v); }
  // 7.0.5 (Miles's Duo, 11/08 IMG_0541 and IMG_0543): the viewer is position:fixed, inset 0, which is the LAYOUT
  // viewport. When the browser has panned the visible part of the page (a keyboard up or just closed, a bar coming and
  // going), that box can sit above what is on screen, so the viewer opened with only its bottom edge showing. It now
  // takes the visible box itself, read the one way Control Web reads it (COSWeb.viewportFit: top and height from
  // visualViewport), as Today's session sheet does, and follows it while it is open (at most once a frame).
  // A breadcrumb records the box on open and whenever it moves by more than 40 px, so a device report has numbers.
  function pinViewer(v) {
    var fit = W.viewportFit, vv = window.visualViewport, frame = 0, last = null;
    function place() {
      frame = 0;
      if (viewer !== v || !v.el.style) return;
      var b = typeof fit === 'function' ? fit() : null;
      if (!b || !b.vv) { v.el.style.top = ''; v.el.style.height = ''; v.el.style.bottom = ''; return; }
      v.el.style.top = b.top + 'px'; v.el.style.height = b.height + 'px'; v.el.style.bottom = 'auto';
      if (W.layoutCrumb && (!last || Math.abs(last.top - b.top) > 40 || Math.abs(last.height - b.height) > 40)) {
        try { W.layoutCrumb(last ? 'viewer-move' : 'viewer-open', { boxTop: b.top, boxH: b.height, inset: b.inset, sy: Math.round(window.scrollY || 0) }); } catch (_e) {}
      }
      last = { top: b.top, height: b.height };
    }
    function soon() { if (!frame) frame = window.requestAnimationFrame ? window.requestAnimationFrame(place) : setTimeout(place, 16); }
    place();
    if (vv && vv.addEventListener) { vv.addEventListener('resize', soon); vv.addEventListener('scroll', soon); }
    if (window.addEventListener) window.addEventListener('resize', soon);
    v.unpin = function () {
      if (vv && vv.removeEventListener) { vv.removeEventListener('resize', soon); vv.removeEventListener('scroll', soon); }
      if (window.removeEventListener) window.removeEventListener('resize', soon);
      if (frame) { if (window.cancelAnimationFrame) window.cancelAnimationFrame(frame); else clearTimeout(frame); frame = 0; }
    };
  }
  function openViewer(scope, item) {
    if (!scope.alive || item.active === false) return;
    var had = viewer; closeViewer(false, true);
    var el = element('div', 'rm-view'), head = element('div', 'rm-view-head'), body = element('div', 'rm-view-body');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Image preview: ' + item.label);
    var close = button('Close image', function () { closeViewer(); });
    head.appendChild(element('h2', 'rm-view-label', item.label)); head.appendChild(close); el.appendChild(head); el.appendChild(body);
    var v = viewer = { el: el, body: body, scope: scope, opener: item.open, close: close, url: '', generation: 0 };
    takeOver(v, had);
    document.body.appendChild(el); document.documentElement.classList.add('rm-viewing'); close.focus();
    function load() {
      body.textContent = ''; var status = element('p', 'rm-status', 'Loading image…'); status.setAttribute('role', 'status'); body.appendChild(status);
      fetchImage(scope, item, 'phone', v, function (url) {
        if (viewer !== v) return;
        body.textContent = ''; var img = element('img'); img.alt = item.label;
        img.addEventListener('error', function () { if (viewer === v && v.url === url) { revoke(v); failure(new Error('Image decode failed')); } });
        img.src = url; body.appendChild(img);
      }, failure);
    }
    function failure(err) {
      if (viewer !== v) return;
      body.textContent = ''; var status = element('p', 'rm-status', failWords(err)); status.setAttribute('role', 'status'); body.appendChild(status);
      if (retryable(err)) body.appendChild(button('Retry image', load));
    }
    load();
  }
  // Window capture runs before Today's document capture handler. An image never pushes history or closes its parent.
  window.addEventListener('keydown', function (e) {
    if (!viewer) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeViewer(); return; }
    if (e.key === 'Tab') {
      var buttons = Array.prototype.slice.call(viewer.el.querySelectorAll('button')).filter(function (b) { return !b.hidden && !b.disabled; });
      var at = buttons.indexOf(document.activeElement), next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
      e.preventDefault(); e.stopImmediatePropagation(); if (buttons[next]) buttons[next].focus();
    }
  }, true);
  function clearRecord(scope, record) {
    record.items.forEach(function (item) {
      item.active = false; item.generation++;
      if (item.open) {
        if (scope.observer) scope.observer.unobserve(item.open);
        if (item.open.__cosToolItem === item) delete item.open.__cosToolItem;
      }
      revoke(item);
    });
    if (viewer && viewer.scope === scope && record.items.some(function (item) { return item.open === viewer.opener; })) closeViewer(false);
  }
  function unmount(host) {
    var scope = scopes.get(host); if (!scope) return;
    scope.alive = false; scope.records.forEach(function (record) { clearRecord(scope, record); }); scopes.delete(host);
    if (scope.observer) { scope.observer.disconnect(); scope.observer = null; }
  }
  function mount(host, provider, sessionId) {
    if (!host || !provider || !sessionId) return;
    var scope = scopes.get(host);
    if (scope && (scope.provider !== provider || scope.id !== sessionId)) { unmount(host); scope = null; }
    if (!scope) { scope = { alive: true, provider: String(provider), id: String(sessionId), records: new Map() }; scopes.set(host, scope); }
    var slots = Array.prototype.slice.call(host.querySelectorAll('[data-reader-images]'));
    var fileSlots = Array.prototype.slice.call(host.querySelectorAll('[data-reader-files]'));
    var toolSlots = Array.prototype.slice.call(host.querySelectorAll('[data-reader-tools]'));
    var linkSlots = Array.prototype.slice.call(host.querySelectorAll('[data-reader-links]'));
    scope.records.forEach(function (record, slot) {
      if (slots.indexOf(slot) < 0 && fileSlots.indexOf(slot) < 0 && toolSlots.indexOf(slot) < 0 && linkSlots.indexOf(slot) < 0) { clearRecord(scope, record); scope.records.delete(slot); }
    });
    mountFiles(host, scope);
    mountTools(host, scope, toolSlots);
    mountLinks(host, scope);
    slots.forEach(function (slot) {
      if (scope.records.has(slot)) return;
      var raw; try { raw = JSON.parse(slot.getAttribute('data-reader-images') || '[]'); } catch (_e) { raw = []; }
      slot.textContent = ''; slot.className = 'cx-strip'; slot.setAttribute('aria-label', 'Session output images');
      var record = { items: [] }; scope.records.set(slot, record);
      (Array.isArray(raw) ? raw : []).forEach(function (dto) {
        if (!dto || !ID.test(dto.id || '') || ['available', 'unavailable'].indexOf(dto.state) < 0) return;
        var item = { id: dto.id, label: String(dto.label || 'Output image').slice(0, 180), generation: 0, url: '', busy: false };
        record.items.push(item);
        var wrap = element('div', 'rm-item');
        item.open = button('Image unavailable', function () { openViewer(scope, item); }, 'cx-thumb');
        item.open.setAttribute('aria-label', 'Open image: ' + item.label); item.open.disabled = true;
        item.status = element('span', 'rm-status'); item.status.setAttribute('role', 'status');
        item.retry = button('Retry image', function () { loadThumb(scope, item); }, 'link-btn'); item.retry.hidden = true;
        wrap.appendChild(item.open); wrap.appendChild(element('span', 'rm-label', item.label)); wrap.appendChild(item.status); wrap.appendChild(item.retry); slot.appendChild(wrap);
        if (dto.state === 'available') loadThumb(scope, item);
        else { item.status.textContent = REASONS[dto.reason] || REASONS.unavailable; item.retry.hidden = dto.reason === 'outside_workspace' || dto.reason === 'missing' || dto.reason === 'secret_file'; }
      });
    });
  }

  // ── Images the session looked at (11/08): a Read of a PNG, a screenshot, a prompt's attached image ──
  // A small thumbnail per image with its tool and place in the step ("Read", "1 of 2"), as the Claude app shows a step.
  // Lazy: nothing is fetched until the thumbnail is near the screen, so a long session never pulls 50 images at once.
  // Without IntersectionObserver the thumbnails load as output images do. Tapping one opens it full size.
  function toolObserver(scope) {
    if (scope.observer !== undefined) return scope.observer;
    var IO = window.IntersectionObserver;
    var observer = typeof IO === 'function' ? new IO(function (entries) {
      // disconnect/unobserve cannot withdraw a callback already queued by the browser.
      if (!scope.alive || scope.observer !== observer) return;
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        observer.unobserve(e.target);
        // Preview engine phase 1: a link card's thumbnail loads the same lazy way.
        var card = e.target.__cosLinkCard;
        if (card) { delete e.target.__cosLinkCard; linkThumb(scope, card); }
        var item = e.target.__cosToolItem;
        if (!item || item.active === false) return;
        delete e.target.__cosToolItem;
        loadThumb(scope, item);
      });
    }, { rootMargin: '300px 0px' }) : null;
    scope.observer = observer;
    return observer;
  }
  function mountTools(host, scope, slots) {
    slots.forEach(function (slot) {
      if (scope.records.has(slot)) return;
      var raw; try { raw = JSON.parse(slot.getAttribute('data-reader-tools') || '{}'); } catch (_e) { raw = {}; }
      var list = raw && Array.isArray(raw.items) ? raw.items : [];
      slot.textContent = ''; slot.className = 'rm-tools' + (raw && raw.before ? ' before' : ''); slot.setAttribute('aria-label', 'Images the session looked at');
      var record = { items: [] }; scope.records.set(slot, record);
      var io = toolObserver(scope);
      list.forEach(function (dto) {
        if (!dto || !TOOL_ID.test(dto.id || '') || ['available', 'unavailable'].indexOf(dto.state) < 0) return;
        var tool = TOOLS.indexOf(dto.tool) >= 0 ? dto.tool : 'Image';
        var index = Math.max(1, Math.floor(Number(dto.index)) || 1), total = Math.max(index, Math.floor(Number(dto.total)) || index);
        var pos = index + ' of ' + total;
        var item = { id: dto.id, label: tool + ', ' + pos, generation: 0, url: '', busy: false };
        record.items.push(item);
        var wrap = element('div', 'rm-tool');
        item.open = button('Image', function () { openViewer(scope, item); }, 'rm-tool-thumb');
        item.open.setAttribute('aria-label', 'Open image: ' + item.label); item.open.disabled = true;
        item.status = element('span', 'rm-status'); item.status.setAttribute('role', 'status');
        item.retry = button('Retry image', function () { loadThumb(scope, item); }, 'link-btn'); item.retry.hidden = true;
        var cap = element('span', 'rm-tool-cap'); cap.appendChild(element('span', 'rm-tool-name', tool)); cap.appendChild(element('span', 'rm-tool-pos', pos));
        wrap.appendChild(item.open); wrap.appendChild(cap); wrap.appendChild(item.status); wrap.appendChild(item.retry); slot.appendChild(wrap);
        if (dto.state !== 'available') {
          item.open.textContent = 'Unavailable';
          item.status.textContent = REASONS[dto.reason] || REASONS.unavailable;
          item.retry.hidden = dto.reason !== 'unavailable' && !!dto.reason;
          return;
        }
        if (io) { item.open.__cosToolItem = item; io.observe(item.open); }
        else loadThumb(scope, item);
      });
      var more = Math.floor(Number(raw && raw.more)) || 0;
      if (more > 0) {
        var m = element('span', 'rm-tool-more', '+' + more + ' more');
        m.setAttribute('title', more === 1 ? 'One more image in this step is not shown here.' : more + ' more images in this step are not shown here.');
        slot.appendChild(m);
      }
    });
  }

  // ── Files a session sent (6.99.35): a card per file, opened through the authenticated output-files route ──
  // A PDF opens in a new tab as a PDF. Text, Markdown, CSV, JSON and SVG show as words in the viewer. HTML shows in a
  // sandboxed frame with no scripts and its own opaque origin, or downloads; it is never opened as a page of this
  // origin. A GIF shows as a picture. Anything else downloads. Every blob is retyped here, never trusted as served.
  var FILE_ID = /^af_[a-f0-9]{64}$/, TEXT_SHOWN = 512 * 1024;
  var OFF = 'Not available on this Mac';
  // QA 7.0.0: a file card has no Retry (a mounted card is never re-read), so a passing failure says the step that works.
  var FILE_REASONS = { secret_file: REASONS.secret_file, outside_workspace: OFF, missing: OFF, unavailable: 'Not available right now. Reopen the session to check again.' };
  var BADGE = { pdf: 'PDF', html: 'HTML', image: 'GIF' };
  function fileUrl(scope, id) {
    return '/api/agent-sessions/' + encodeURIComponent(scope.provider) + '/' + encodeURIComponent(scope.id) + '/output-files/' + encodeURIComponent(id) + '/content';
  }
  function bytesWords(n) {
    if (typeof n !== 'number' || !(n >= 0)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }
  function badge(f) {
    if (BADGE[f.kind]) return BADGE[f.kind];
    var ext = /\.([a-z0-9]{1,4})$/i.exec(f.name); return ext ? ext[1].toUpperCase() : 'FILE';
  }
  function fileFailWords(err) {
    if (busy(err)) return 'Your Mac is busy with other previews. Try again in a moment.';
    if (err && err.status === 403 && err.code === 'secret_file_denied') return REASONS.secret_file;
    if (err && err.status === 401) return 'Signed out. Connect this browser again to open the file.';
    if (err && err.status === 403) return 'Previews are off. Turn them on in Settings, Privacy.';
    if (err && err.status === 404) return 'This file is no longer in the recent turns. Reopen the session to refresh it.';
    if (err && err.status === 413) return 'Too large to open here. Open it on your Mac.';
    return 'The file could not load. Check that your Mac is awake, then retry.';
  }
  function fetchFile(scope, f) {
    return imageRequest(fileUrl(scope, f.id), function () { return scope.alive; }, true).then(function (blob) {
      if (!blob || typeof blob.size !== 'number') throw new Error('No file');
      return blob;
    });
  }
  // A download is always typed application/octet-stream, so no browser renders it as a page of this origin.
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
    var a = element('a'); a.href = url; a.download = name; a.rel = 'noopener'; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function openPdf(blob, pending) {
    var url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    setTimeout(function () { URL.revokeObjectURL(url); }, 5 * 60000);
    if (pending && !pending.closed) { try { pending.location.href = url; return true; } catch (_e) { /* fall through */ } }
    return false;
  }
  function fileViewer(scope, f, opener) {
    // Preview engine phase 1: with the shared viewer loaded, a sent file opens in it (Markdown rendered, code with line
    // numbers, CSV as a table, HTML full length with a per-open Run scripts). Without it, the 6.99.35 viewer below.
    if (W.preview && (f.kind === 'text' || f.kind === 'html')) return openPreview(scope, { id: f.id, name: f.name, label: f.name, kind: W.preview.kindOf(f.name), type: f.type, size: f.size, state: f.state }, opener);
    var had = viewer; closeViewer(false, true);
    var el = element('div', 'rm-view'), head = element('div', 'rm-view-head'), body = element('div', 'rm-view-body'), acts = element('div', 'rm-view-acts');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', f.type + ': ' + f.name);
    var close = button('Close', function () { closeViewer(); });
    acts.appendChild(button('Download', function () { fetchFile(scope, f).then(function (b) { saveBlob(b, f.name); }, failure); }));
    acts.appendChild(close);
    head.appendChild(element('h2', 'rm-view-label', f.name)); head.appendChild(acts); el.appendChild(head); el.appendChild(body);
    var v = viewer = { el: el, body: body, scope: scope, opener: opener, close: close, url: '', generation: 0 };
    takeOver(v, had);
    document.body.appendChild(el); document.documentElement.classList.add('rm-viewing'); close.focus();
    function failure(err) {
      if (viewer !== v) return;
      body.textContent = ''; var st = element('p', 'rm-status', fileFailWords(err)); st.setAttribute('role', 'status'); body.appendChild(st);
    }
    var status = element('p', 'rm-status', 'Loading ' + f.name + '…'); status.setAttribute('role', 'status'); body.appendChild(status);
    fetchFile(scope, f).then(function (blob) {
      if (viewer !== v) return;
      if (f.kind === 'image') {
        revoke(v); v.url = URL.createObjectURL(new Blob([blob], { type: 'image/gif' }));
        body.textContent = ''; var img = element('img'); img.alt = f.name; img.src = v.url; body.appendChild(img); return;
      }
      return blob.slice(0, TEXT_SHOWN).text().then(function (text) {
        if (viewer !== v) return;
        body.textContent = '';
        if (f.kind === 'html') {
          // sandbox with no allow-* tokens: no scripts, no forms, no popups, an opaque origin. srcdoc, so no URL of this origin.
          var frame = element('iframe', 'rm-frame'); frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer');
          frame.title = 'Preview of ' + f.name + ' (scripts off)'; frame.srcdoc = text; body.appendChild(frame);
          body.appendChild(element('p', 'rm-status', 'Preview with scripts off. Download it to open it fully.'));
        } else {
          body.appendChild(element('pre', 'rm-text', text));
          if (blob.size > TEXT_SHOWN) body.appendChild(element('p', 'rm-status', 'Showing the first 512 KB. Download it for the rest.'));
        }
      });
    }).catch(failure);
  }
  function fileCard(scope, record, f) {
    var card = element('div', 'rm-file' + (f.state === 'available' ? '' : ' off'));
    var icon = element('span', 'rm-file-icon', badge(f)); icon.setAttribute('aria-hidden', 'true');
    var meta = element('span', 'rm-file-meta', [f.type, bytesWords(f.size)].filter(Boolean).join(' · '));
    var acts = element('div', 'rm-file-acts');
    var status = element('span', 'rm-status'); status.setAttribute('role', 'status');
    card.appendChild(icon); card.appendChild(element('span', 'rm-file-name', f.name)); card.appendChild(meta); card.appendChild(acts); card.appendChild(status);
    var item = { open: null, generation: 0, url: '' }; record.items.push(item);
    if (f.state !== 'available') { meta.textContent = f.type + ' · ' + (FILE_REASONS[f.reason] || OFF); return card; }
    function busy(b, on, words) { b.disabled = on; status.textContent = on ? words : ''; }
    if (f.kind === 'pdf') {
      var openPdfBtn = item.open = button('Open', function () {
        // Preview engine phase 1: on a desktop a PDF opens inline in the viewer; a phone keeps the new tab.
        if (W.preview && !W.preview.isPhone()) { openPreview(scope, { id: f.id, name: f.name, label: f.name, kind: 'pdf', type: f.type, size: f.size, state: f.state }, openPdfBtn); return; }
        // The tab opens on the tap (a later window.open is blocked), then shows the PDF when it arrives.
        var pending = null; try { pending = window.open('', '_blank'); } catch (_e) { pending = null; }
        busy(openPdfBtn, true, 'Opening ' + f.name + '…');
        fetchFile(scope, f).then(function (blob) {
          busy(openPdfBtn, false, '');
          if (!openPdf(blob, pending)) {
            var url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
            var link = element('a', 'link-btn', 'Show the PDF'); link.href = url; link.target = '_blank'; link.rel = 'noopener';
            status.textContent = ''; status.appendChild(link);
            setTimeout(function () { URL.revokeObjectURL(url); }, 5 * 60000);
          }
        }, function (err) { if (pending) try { pending.close(); } catch (_e) {} busy(openPdfBtn, false, ''); status.textContent = fileFailWords(err); });
      }, 'cx-btn');
      openPdfBtn.setAttribute('aria-label', 'Open PDF: ' + f.name); acts.appendChild(openPdfBtn);
    } else if (f.kind === 'text' || f.kind === 'html' || f.kind === 'image') {
      var view = item.open = button(f.kind === 'html' ? 'Preview' : 'Open', function () { fileViewer(scope, f, view); }, 'cx-btn');
      view.setAttribute('aria-label', (f.kind === 'html' ? 'Preview ' : 'Open ') + f.name); acts.appendChild(view);
    }
    if (f.kind !== 'text' && f.kind !== 'image') {
      var save = button('Download', function () {
        busy(save, true, 'Downloading ' + f.name + '…');
        fetchFile(scope, f).then(function (blob) { busy(save, false, ''); saveBlob(blob, f.name); }, function (err) { busy(save, false, ''); status.textContent = fileFailWords(err); });
      }, f.kind === 'file' ? 'cx-btn' : 'cx-btn quiet');
      save.setAttribute('aria-label', 'Download ' + f.name); acts.appendChild(save);
      if (!item.open) item.open = save;
    }
    return card;
  }
  function mountFiles(host, scope) {
    var slots = Array.prototype.slice.call(host.querySelectorAll('[data-reader-files]'));
    slots.forEach(function (slot) {
      if (scope.records.has(slot)) return;
      var raw; try { raw = JSON.parse(slot.getAttribute('data-reader-files') || '[]'); } catch (_e) { raw = []; }
      slot.textContent = ''; slot.className = 'rm-files'; slot.setAttribute('aria-label', 'Files the session sent');
      var record = { items: [] }; scope.records.set(slot, record);
      (Array.isArray(raw) ? raw : []).forEach(function (dto) {
        if (!dto || !FILE_ID.test(dto.id || '') || ['available', 'unavailable'].indexOf(dto.state) < 0) return;
        var f = { id: dto.id, name: String(dto.name || 'File').slice(0, 120), kind: ['pdf', 'text', 'html', 'image', 'file'].indexOf(dto.kind) >= 0 ? dto.kind : 'file',
          type: String(dto.type || 'File').slice(0, 40), size: typeof dto.size === 'number' ? dto.size : null, state: dto.state, reason: dto.reason };
        slot.appendChild(fileCard(scope, record, f));
      });
    });
    return slots;
  }

  // ── Preview engine phase 1: link cards and the shared viewer (panes/preview.js draws; this shell owns history) ──
  function saveRaw(scope, f, failure) {
    imageRequest(W.preview.url(scope, f.id, 'raw'), function () { return scope.alive; }, true).then(function (b) { saveBlob(b, f.name); }, failure);
  }
  function openPreview(scope, dto, opener) {
    var f = W.preview && W.preview.clean(dto);
    if (!f) return;
    // A phone opens a PDF in its own tab, on the tap (a later window.open is blocked).
    if (f.kind === 'pdf' && W.preview.isPhone()) { try { window.open(W.preview.url(scope, f.id, 'inline'), '_blank', 'noopener'); } catch (_e) {} return; }
    var had = viewer; closeViewer(false, true);
    var el = element('div', 'rm-view'), head = element('div', 'rm-view-head'), body = element('div', 'rm-view-body'), acts = element('div', 'rm-view-acts');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', f.type + ': ' + f.name);
    var close = button('Close', function () { closeViewer(); });
    var v = viewer = { el: el, body: body, scope: scope, opener: opener, close: close, url: '', generation: 0 };
    if (W.preview.parts(f).indexOf('raw') >= 0) acts.appendChild(button('Download', function () { saveRaw(scope, f, function (err) { if (viewer === v) { var st = element('p', 'rm-status', W.preview.failWords(err)); st.setAttribute('role', 'status'); body.appendChild(st); } }); }));
    acts.appendChild(close);
    head.appendChild(element('h2', 'rm-view-label', f.name + (f.line ? ':' + f.line : ''))); head.appendChild(acts); el.appendChild(head); el.appendChild(body);
    takeOver(v, had);
    document.body.appendChild(el); document.documentElement.classList.add('rm-viewing'); close.focus();
    var generation = v.generation;
    W.preview.render({
      body: body, acts: acts,
      alive: function () { return viewer === v && v.generation === generation && scope.alive; },
      request: function (u, foreground, type) { return imageRequest(u, function () { return viewer === v && scope.alive; }, foreground !== false, type); },
      setUrl: function (u) { revoke(v); v.url = u; }, url: function () { return v.url; }
    }, scope, f);
  }
  // A card where each local link sits: [data-reader-link="N"] inside a [data-reader-links] list from the server.
  function linkThumb(scope, card, record) {
    var t = card.thumb; if (!t) return;
    var generation = ++card.generation;
    imageRequest(W.preview.url(scope, card.f.id, 'thumb'), function () { return scope.alive && generation === card.generation; }, false).then(function (blob) {
      if (!scope.alive || generation !== card.generation) return;
      if (!blob || !blob.size) throw new Error('No thumbnail');
      revoke(card); card.url = URL.createObjectURL(new Blob([blob], { type: 'image/png' }));
      t.textContent = ''; var img = element('img'); img.alt = ''; img.src = card.url; t.appendChild(img);
    }).catch(function (err) {
      if (!scope.alive || generation !== card.generation) return;
      // 7.0.4 QA's busy rule: a busy Mac is asked again after about 1, 2, 4 and 8 seconds, then the card stays plain.
      if (busy(err) && (card.busyTries || 0) < BUSY_RETRIES) {
        var delay = busyDelay(card.busyTries || 0); card.busyTries = (card.busyTries || 0) + 1;
        setTimeout(function () { if (scope.alive && generation === card.generation && !card.url) linkThumb(scope, card, record); }, delay);
        return;
      }
      // No Quick Look picture on this Mac: an honest card, never a broken image.
      t.textContent = 'PDF'; t.title = 'No preview image';
    });
  }
  function mountLinks(host, scope) {
    if (!W.preview) return;
    Array.prototype.slice.call(host.querySelectorAll('[data-reader-links]')).forEach(function (list) {
      if (scope.records.has(list)) return;
      var raw; try { raw = JSON.parse(list.getAttribute('data-reader-links') || '[]'); } catch (_e) { raw = []; }
      var dtos = Array.isArray(raw) ? raw.slice(0, 20) : [];
      var record = { items: [] }; scope.records.set(list, record);
      var io = toolObserver(scope);
      Array.prototype.slice.call(list.querySelectorAll('[data-reader-link]')).forEach(function (slot) {
        var n = Math.floor(Number(slot.getAttribute('data-reader-link')));
        var dto = n >= 0 && n < dtos.length ? dtos[n] : null;
        var card = dto && W.preview.chip(scope, dto, slot.textContent, function (f, el) { openPreview(scope, f, el); });
        if (!card) return;
        record.items.push(card); card.open = card.el;
        slot.textContent = ''; slot.appendChild(card.el);
        if (card.thumb) { if (io) { card.el.__cosToolItem = null; card.el.__cosLinkCard = card; io.observe(card.el); } else linkThumb(scope, card, record); }
      });
    });
  }

  W.readerMedia = { mount: mount, unmount: unmount, isOpen: function () { return !!viewer; }, close: closeViewer, popIsMine: popIsMine, openPreview: openPreview };
  W.registerPane('readerMedia', W.readerMedia);
})();
