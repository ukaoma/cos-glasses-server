/* Native session output images. Only opaque DTO ids reach the content route; markdown and paths are never sources. */
(function () {
  'use strict';
  var W = window.COSWeb;
  if (!W) return;
  var scopes = new Map(), viewer = null, requests = [], activeRequests = 0;
  var ID = /^ai_[a-f0-9]{64}$/;
  // outside_workspace and missing are permanent. unavailable means the workspace lookup failed this time; the content route
  // re-resolves it. 6.99.35: outside the workspace and missing (a file a session sent that is gone) read the same, with no path.
  var REASONS = { outside_workspace: 'Not available on this Mac.', missing: 'Not available on this Mac.',
    unavailable: 'This image is temporarily unavailable. Retry in a moment.' };
  var style = document.createElement('style');
  style.textContent = '.rm-item{display:flex;flex-direction:column;gap:6px;max-width:180px}.rm-label,.rm-status{font:12px/1.4 var(--body);color:var(--sub);overflow-wrap:anywhere}.rm-label{color:var(--text)}.rm-item .cx-thumb{cursor:pointer}.rm-view{position:fixed;inset:0;z-index:10000;background:var(--bg,#171717);color:var(--text,#fff);display:flex;flex-direction:column;padding: max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));gap:16px}.rm-view-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.rm-view-label{margin:0;overflow-wrap:anywhere;font:16px/1.4 var(--body)}.rm-view-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}.rm-view img{max-width:100%;max-height:100%;object-fit:contain}.rm-viewing{overflow:hidden!important}.rm-files{display:flex;flex-direction:column;gap:8px;margin-top:10px}.rm-file{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:10px 12px;border:1px solid var(--panel-border);border-radius:12px;background:var(--panel);max-width:560px}.rm-file-icon{grid-row:1/span 2;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;background:var(--bg);border:1px solid var(--panel-border);font:600 11px/1 var(--body);letter-spacing:.04em;color:var(--sub)}.rm-file-name{font:500 14px/1.35 var(--body);color:var(--text);overflow-wrap:anywhere;min-width:0}.rm-file-meta{font:12px/1.4 var(--body);color:var(--sub);grid-column:2;min-width:0}.rm-file-acts{grid-column:3;grid-row:1/span 2;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.rm-file-acts .cx-btn{min-height:44px}.rm-file .rm-status{grid-column:1/-1}.rm-file.off{opacity:.78}.rm-view-acts{display:flex;gap:8px;align-items:center}.rm-text{flex:1;min-height:0;width:100%;overflow:auto;margin:0;padding:12px;border:1px solid var(--panel-border);border-radius:10px;background:var(--panel);font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.rm-frame{flex:1;min-height:0;width:100%;border:1px solid var(--panel-border);border-radius:10px;background:#fff}@media (max-width:599px){.rm-file{grid-template-columns:40px minmax(0,1fr)}.rm-file-icon{width:40px;height:40px}.rm-file-acts{grid-column:1/-1;grid-row:auto;justify-content:flex-start}}';
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
    if (err && err.status === 403) return 'Previews are off. Turn them on in Settings, Privacy.';
    if (err && err.status === 404) return 'This image is no longer available. Reopen the session to refresh its images.';
    return 'The image could not load. Check that your Mac is awake, then retry.';
  }
  function retryable(err) { return !(err && (err.status === 401 || err.status === 403 || err.status === 404)); }
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
    var fileSlots = Array.prototype.slice.call(host.querySelectorAll('[data-reader-files]'));
    scope.records.forEach(function (record, slot) { if (slots.indexOf(slot) < 0 && fileSlots.indexOf(slot) < 0) { clearRecord(scope, record); scope.records.delete(slot); } });
    mountFiles(host, scope);
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
        else { item.status.textContent = REASONS[dto.reason] || REASONS.unavailable; item.retry.hidden = dto.reason === 'outside_workspace' || dto.reason === 'missing'; }
      });
    });
  }

  // ── Files a session sent (6.99.35): a card per file, opened through the authenticated output-files route ──
  // A PDF opens in a new tab as a PDF. Text, Markdown, CSV, JSON and SVG show as words in the viewer. HTML shows in a
  // sandboxed frame with no scripts and its own opaque origin, or downloads; it is never opened as a page of this
  // origin. A GIF shows as a picture. Anything else downloads. Every blob is retyped here, never trusted as served.
  var FILE_ID = /^af_[a-f0-9]{64}$/, TEXT_SHOWN = 512 * 1024;
  var OFF = 'Not available on this Mac';
  // QA 7.0.0: a file card has no Retry (a mounted card is never re-read), so a passing failure says the step that works.
  var FILE_REASONS = { outside_workspace: OFF, missing: OFF, unavailable: 'Not available right now. Reopen the session to check again.' };
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
    closeViewer(false);
    var el = element('div', 'rm-view'), head = element('div', 'rm-view-head'), body = element('div', 'rm-view-body'), acts = element('div', 'rm-view-acts');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', f.type + ': ' + f.name);
    var close = button('Close', function () { closeViewer(); });
    acts.appendChild(button('Download', function () { fetchFile(scope, f).then(function (b) { saveBlob(b, f.name); }, failure); }));
    acts.appendChild(close);
    head.appendChild(element('h2', 'rm-view-label', f.name)); head.appendChild(acts); el.appendChild(head); el.appendChild(body);
    var v = viewer = { el: el, body: body, scope: scope, opener: opener, close: close, url: '', generation: 0 };
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

  W.readerMedia = { mount: mount, unmount: unmount, isOpen: function () { return !!viewer; }, close: closeViewer };
  W.registerPane('readerMedia', W.readerMedia);
})();
