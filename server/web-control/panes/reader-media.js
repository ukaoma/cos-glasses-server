/* Native session output images. Only opaque DTO ids reach the content route; markdown and paths are never sources. */
(function () {
  'use strict';
  var W = window.COSWeb;
  if (!W) return;
  var scopes = new Map(), viewer = null, requests = [], activeRequests = 0;
  var ID = /^ai_[a-f0-9]{64}$/;
  // outside_workspace is permanent. unavailable means the workspace lookup failed this time; the content route re-resolves it.
  var REASONS = { outside_workspace: 'This image is outside the session workspace.',
    unavailable: 'This image is temporarily unavailable. Retry in a moment.' };
  var style = document.createElement('style');
  style.textContent = '.rm-item{display:flex;flex-direction:column;gap:6px;max-width:180px}.rm-label,.rm-status{font:12px/1.4 var(--body);color:var(--sub);overflow-wrap:anywhere}.rm-label{color:var(--text)}.rm-item .cx-thumb{cursor:pointer}.rm-view{position:fixed;inset:0;z-index:10000;background:var(--bg,#171717);color:var(--text,#fff);display:flex;flex-direction:column;padding: max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));gap:16px}.rm-view-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.rm-view-label{margin:0;overflow-wrap:anywhere;font:16px/1.4 var(--body)}.rm-view-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}.rm-view img{max-width:100%;max-height:100%;object-fit:contain}.rm-viewing{overflow:hidden!important}';
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
    return '/api/agent-sessions/' + encodeURIComponent(scope.provider) + '/' + encodeURIComponent(scope.id) + '/output-images/' + encodeURIComponent(id) + '/content?variant=' + variant;
  }
  function revoke(item) { if (item.url) { URL.revokeObjectURL(item.url); item.url = ''; } }
  function failWords(err) {
    if (err && err.status === 401) return 'Signed out. Connect this browser again to view the image.';
    if (err && err.status === 404) return 'This image is no longer available. Reopen the session to refresh its images.';
    return 'The image could not load. Check that your Mac is awake, then retry.';
  }
  function retryable(err) { return !(err && (err.status === 401 || err.status === 404)); }
  function imageBlob(blob) { return blob && /^image\/(png|jpeg|webp|gif|avif)$/.test(blob.type || '') && blob.size > 0; }
  // The server normalizes at most two images at once. Share that budget across both readers and the viewer.
  function pump() {
    while (activeRequests < 2 && requests.length) {
      var job = requests.shift();
      if (!job.valid()) { job.resolve(null); continue; }
      activeRequests++;
      (function (j) {
        Promise.resolve().then(j.run).then(j.resolve, j.reject).then(function () { activeRequests--; pump(); });
      })(job);
    }
  }
  function imageRequest(url, valid, foreground) {
    return new Promise(function (resolve, reject) {
      var job = { valid: valid, resolve: resolve, reject: reject, run: function () { return W.api(url, { responseType: 'blob', timeoutMs: 20000 }); } };
      if (foreground) requests.unshift(job); else requests.push(job);
      pump();
    });
  }
  function fetchImage(scope, item, variant, target, ready, failed) {
    var generation = ++target.generation;
    imageRequest(path(scope, item.id, variant), function () { return scope.alive && generation === target.generation; }, variant === 'phone').then(function (blob) {
      if (!scope.alive || generation !== target.generation) return;
      if (!imageBlob(blob)) throw new Error('Not a supported image');
      revoke(target); target.url = URL.createObjectURL(blob); ready(target.url);
    }).catch(function (err) {
      if (scope.alive && generation === target.generation) failed(err);
    });
  }
  function loadThumb(scope, item) {
    if (item.busy) return;
    item.busy = true; item.open.textContent = 'Loading image…'; item.status.textContent = 'Loading image…'; item.retry.hidden = true; item.open.disabled = true;
    fetchImage(scope, item, 'thumb', item, function (url) {
      item.busy = false; item.open.textContent = '';
      var img = element('img'); img.alt = item.label;
      img.addEventListener('error', function () {
        if (!scope.alive || item.url !== url) return;
        revoke(item); item.open.textContent = 'Image unavailable'; item.open.disabled = true;
        item.status.textContent = 'The image could not be displayed.'; item.retry.hidden = false;
      });
      img.src = url; item.open.appendChild(img); item.open.disabled = false; item.status.textContent = '';
    }, function (err) {
      item.busy = false; item.open.textContent = 'Image unavailable'; item.status.textContent = failWords(err); item.retry.hidden = !retryable(err);
    });
  }
  function closeViewer(restore) {
    var v = viewer; if (!v) return;
    viewer = null; v.generation++; revoke(v); v.el.remove(); document.documentElement.classList.remove('rm-viewing');
    if (restore !== false && v.opener && v.opener.isConnected) v.opener.focus();
  }
  function openViewer(scope, item) {
    closeViewer(false);
    var el = element('div', 'rm-view'), head = element('div', 'rm-view-head'), body = element('div', 'rm-view-body');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Image preview: ' + item.label);
    var close = button('Close image', function () { closeViewer(); });
    head.appendChild(element('h2', 'rm-view-label', item.label)); head.appendChild(close); el.appendChild(head); el.appendChild(body);
    var v = viewer = { el: el, body: body, scope: scope, opener: item.open, close: close, url: '', generation: 0 };
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
    record.items.forEach(function (item) { item.generation++; revoke(item); });
    if (viewer && viewer.scope === scope && record.items.some(function (item) { return item.open === viewer.opener; })) closeViewer(false);
  }
  function unmount(host) {
    var scope = scopes.get(host); if (!scope) return;
    scope.alive = false; scope.records.forEach(function (record) { clearRecord(scope, record); }); scopes.delete(host);
  }
  function mount(host, provider, sessionId) {
    if (!host || !provider || !sessionId) return;
    var scope = scopes.get(host);
    if (scope && (scope.provider !== provider || scope.id !== sessionId)) { unmount(host); scope = null; }
    if (!scope) { scope = { alive: true, provider: String(provider), id: String(sessionId), records: new Map() }; scopes.set(host, scope); }
    var slots = Array.prototype.slice.call(host.querySelectorAll('[data-reader-images]'));
    scope.records.forEach(function (record, slot) { if (slots.indexOf(slot) < 0) { clearRecord(scope, record); scope.records.delete(slot); } });
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
        else { item.status.textContent = REASONS[dto.reason] || REASONS.unavailable; item.retry.hidden = dto.reason === 'outside_workspace'; }
      });
    });
  }
  W.readerMedia = { mount: mount, unmount: unmount, isOpen: function () { return !!viewer; }, close: closeViewer };
  W.registerPane('readerMedia', W.readerMedia);
})();
