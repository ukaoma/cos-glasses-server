// The phone key signer page on https://<this Mac's MagicDNS name>:3144 (6.99.31, plan Phase 3, review
// B2 and W2). It holds the key and nothing else: no transcripts, no previews, no other app data.
//
// What it never does:
//   - run inside a frame (CSP frame-ancestors 'none' plus the check below, before anything is read)
//   - sign because another page asked: there is no postMessage listener, the words come from the Mac
//     by a one-use handoff id, and a signature happens only after a real tap (event.isTrusted) here
//   - take its origin from anyone: the envelope names location.origin, so a copy of this page served
//     from any other origin can never produce a signature this server accepts
//
// The proof itself is assembled by signer-proof.js (one module, the seam a companion app signer will
// reuse). This file is the page: storage, WebAuthn, the screen, the network.
(function (W) {
  'use strict'
  var P = W.COSSignerProof, S = W.COSSignerStore, D = W.document
  var SECTIONS = ['loading', 'framed', 'enroll', 'pending', 'sign', 'done', 'idle', 'problem']
  var POLL_MS = 2000
  var state = { record: null, handoff: null, shownWords: null, nonce: null, enrolling: null, busy: false, revokeArmed: false }

  var COPY = {
    device_not_allowed: 'This phone is not allowed to set up a key. Add its Tailscale address to COS_WEB_KEY_DEVICES on the Mac, then try again.',
    enrollment_pending: 'Another phone is setting up a key right now. Wait five minutes or finish that one first.',
    key_cap_reached: 'Two phones already have keys. Revoke one in COS Control first.',
    anchor_not_registered: 'COS Control on the Mac has not set up its approval key yet.',
    anchor_unregistered: 'COS Control on the Mac has not set up its approval key yet.',
    web_key_authority_off: 'Phone approval is turned off on the Mac.',
    web_origin_required: 'Open this page from your phone over Tailscale, signed in to COS Control Web.',
    signer_origin_required: 'Open this page from the approval address on port 3144.',
    unauthorized: 'This browser is not signed in to COS Control Web. Sign in there first.',
    handoff_unknown: 'This approval link is not known. Start again from Control.',
    handoff_expired: 'This approval link has expired. Start again from Control.',
    handoff_claimed: 'This approval link was already opened. Start again from Control.',
    commit_mismatch: 'The setup check failed. Start again.',
    enroll_burned: 'Setup failed three times and was stopped. Start again.',
    enroll_unknown: 'That setup request has ended. Start again.',
    passkey_invalid: 'Your passkey did not confirm the setup. Start again.',
    passkey_malformed: 'The passkey could not be read. Start again.',
    passkey_cancelled: 'Passkey confirmation was cancelled. Nothing was signed.',
    packet_mismatch: 'The release request does not match its signed scope. Nothing was signed. Return to Control and open the request again.',
    packet_expired: 'The release request expired. Ask the session for a fresh request. Nothing was signed.',
    nonce_store_unavailable: 'The Mac cannot issue one-time codes right now. Nothing was signed.',
  }
  function reasonCopy(reason) { return COPY[reason] || ('COS said no (' + String(reason || 'unknown') + '). Nothing was signed.') }
  function refusal(reason) { var e = new Error(reason); e.reason = reason; return e }

  function $(id) { return D.getElementById(id) }
  function show(id) { SECTIONS.forEach(function (s) { var el = $(s); if (el) el.hidden = s !== id }) }
  function setText(id, s) { var el = $(id); if (el) el.textContent = s == null ? '' : String(s) }
  function problem(copy) { setText('problem-text', copy); show('problem') }
  function framed() { try { return W.top !== W.self } catch (_e) { return true } }
  function spacedCode(code) { return String(code).slice(0, 3) + ' ' + String(code).slice(3) }
  function controlUrl() { return 'https://' + W.location.hostname + ':3143/control/' }

  function api(path, opts) {
    var o = opts || {}
    var headers = { 'X-COS-Web': '1' }
    if (o.body !== undefined) headers['Content-Type'] = 'application/json'
    if (o.headers) Object.keys(o.headers).forEach(function (k) { headers[k] = o.headers[k] })
    return W.fetch(path, {
      method: o.method || 'GET', headers: headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    }).then(function (res) {
      return res.text().then(function (t) { var b = {}; try { b = t ? JSON.parse(t) : {} } catch (_e) { b = {} } return { status: res.status, body: b || {} } })
    })
  }

  // ── the page's signer: the WebCrypto key in IndexedDB plus the passkey (signer-proof.js interface) ──
  function assertWith(credentialId, challenge) {
    return W.navigator.credentials.get({
      publicKey: {
        challenge: challenge, rpId: W.location.hostname, userVerification: 'required', timeout: 120000,
        allowCredentials: [{ type: 'public-key', id: P.fromB64url(credentialId) }],
      },
    }).then(function (cred) {
      if (!cred || !cred.response) throw refusal('passkey_cancelled')
      return {
        credentialId: P.b64url(cred.rawId),
        authenticatorData: P.b64url(cred.response.authenticatorData),
        clientDataJSON: P.b64url(cred.response.clientDataJSON),
        signature: P.b64url(cred.response.signature),
      }
    }, function () { throw refusal('passkey_cancelled') })
  }
  function pageSigner(record) {
    return {
      kid: record.kid,
      signEnvelope: function (bytes) {
        return W.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, record.keyPair.privateKey, bytes).then(function (b) { return new Uint8Array(b) })
      },
      assert: function (challenge) { return assertWith(record.credentialId, challenge) },
    }
  }

  // ── boot ──
  function handoffIdFromHash() {
    var m = /^#h=([A-Za-z0-9_-]{16,64})$/.exec(String(W.location.hash || ''))
    return m ? m[1] : null
  }
  function paintKey(rec) {
    setText('key-label', rec.label || 'This phone')
    setText('key-fingerprint', rec.fingerprint || '')
  }
  function boot() {
    // Framed: stop before the key store is opened or the handoff is claimed.
    if (framed()) { show('framed'); return Promise.resolve() }
    var id = handoffIdFromHash()
    // The id is single use; drop it from the address so a reload or a shared screenshot cannot reuse it.
    try { if (W.location.hash) W.history.replaceState(null, '', W.location.pathname) } catch (_e) { /* not fatal */ }
    return S.get().then(function (rec) {
      state.record = rec
      if (!rec) { show('enroll'); return undefined }
      paintKey(rec)
      if (rec.state === 'pending') return watchEnrollment(rec)
      if (!id) { show('idle'); return undefined }
      return claim(id)
    }).catch(function (err) { problem(reasonCopy(err && err.reason ? err.reason : 'storage_unavailable')) })
  }

  // ── per-turn signing ──
  function providerName(p) { return p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : p === 'cursor' ? 'Cursor' : String(p) }
  function scopeLine(scope) {
    if (!scope || scope.kind === 'message') return 'Message only. It approves no install, publish or push.'
    if (scope.kind === 'approve') return 'Approve ' + scope.action + ': ' + scope.artifact + ' ' + scope.version + ' on ' + scope.channel + ' (' + scope.digest + ')'
    return 'Unknown'
  }
  function deploymentMeaning(scope) {
    var targets = { 'gotcos-site': 'gotcos.com website (cos-starter Pages)', 'control-downloads': 'COS Control GitHub release downloads and approved latest aliases', 'release-docs': 'Public COS release documentation' }
    return scope && Object.prototype.hasOwnProperty.call(targets, scope.channel) ? '\nDeployment target: ' + targets[scope.channel] + '\nApproval is limited to this exact manifest SHA-256. The receiving release tool checks its files and destination.' : ''
  }
  function claim(id) {
    show('loading')
    return api('/api/web-key/handoff/claim', { method: 'POST', body: { handoffId: id } }).then(function (a) {
      if (a.status !== 200 || a.body.ok !== true || !a.body.handoff) return problem(reasonCopy(a.body.error || 'handoff_unknown'))
      return render(a.body.handoff)
    })
  }
  function render(h) {
    return P.validateHandoffPacket(h, Date.now()).then(function () { return renderChecked(h) }, function (err) {
      return problem(reasonCopy(err && err.reason ? err.reason : 'packet_mismatch'))
    })
  }
  function renderChecked(h) {
    var words = P.signedWords(h.words)
    if (!words.trim()) return problem('There is nothing to approve: the message is empty.')
    if (h.attachments && h.attachments.length) return problem('Files cannot be approved on this phone yet. Nothing was signed.')
    state.handoff = h
    state.shownWords = words
    setText('sign-words', words)
    setText('sign-provider', providerName(h.provider))
    setText('sign-session', h.sessionId)
    setText('sign-scope', scopeLine(h.scope))
    state.shownPacket = h.packet ? P.canonicalJson(h.packet) + '\nPacket SHA-256: ' + h.scope.packetSha256 + '\nExpires: ' + new Date(h.packet.exp).toISOString() + deploymentMeaning(h.scope) : ''
    setText('sign-packet', state.shownPacket)
    var packetBox = $('sign-packet'); if (packetBox) packetBox.hidden = !state.shownPacket
    setText('sign-status', '')
    show('sign')
    // Fetched now, so the tap goes straight to signing and the phone passkey with no network wait in between
    // (Safari allows a passkey prompt only close to the tap). A nonce is single use and harmless unused.
    state.nonce = api('/api/web-key/nonce', { method: 'POST', body: {} }).then(null, function () { return { status: 0, body: {} } })
    return state.nonce
  }
  function onApprove(ev) {
    // Only a real tap on this page signs. A script-made click (isTrusted false) does nothing.
    if (!ev || ev.isTrusted !== true) return undefined
    if (state.busy || !state.handoff || !state.record || state.record.state !== 'enrolled') return undefined
    var h = state.handoff, rec = state.record
    // The words signed are the words on the screen, read back from it.
    var shown = $('sign-words').textContent
    if (shown !== state.shownWords) { problem('The words on screen changed. Nothing was signed.'); return undefined }
    if (($('sign-packet') ? $('sign-packet').textContent : '') !== state.shownPacket) { problem('The release request on screen changed. Nothing was signed.'); return undefined }
    state.busy = true
    var btn = $('sign-approve'); if (btn) btn.disabled = true
    var nonce = state.nonce || api('/api/web-key/nonce', { method: 'POST', body: {} })
    state.nonce = null
    return nonce.then(function (n) {
      if (n.status !== 201 || n.body.ok !== true) throw refusal(n.body.error || 'nonce_failed')
      setText('sign-status', 'Confirm with your phone passkey.')
      return P.assembleTurnProof({
        handoff: { words: shown, provider: h.provider, sessionId: h.sessionId, bindingId: h.bindingId, scope: h.scope, packet: h.packet, attachments: [], turn: h.turn },
        nonce: n.body, signer: pageSigner(rec), origin: W.location.origin, nowMs: Date.now(),
      })
    }).then(function (proof) {
      if (proof.words !== shown) throw refusal('words_changed')
      setText('sign-status', 'Sending.')
      return api('/api/agent-sessions/bindings/' + encodeURIComponent(h.bindingId) + '/turns', { method: 'POST', headers: proof.headers, body: proof.body })
    }).then(function (t) {
      var b = t.body || {}
      if (t.status >= 200 && t.status < 300 && (b.outcome === 'queued' || b.outcome === 'completed')) {
        setText('done-text', b.replayed ? 'This message was already sent.' : 'Sent to the ' + providerName(h.provider) + ' session with your approval.')
        show('done')
        return undefined
      }
      problem(b.reasonCopy || reasonCopy(b.reason || b.error || 'turn_refused'))
      return undefined
    }).catch(function (err) {
      problem(reasonCopy(err && err.reason ? err.reason : 'signing_failed'))
    }).then(function () {
      state.busy = false
      state.handoff = null
      if (btn) btn.disabled = false
    })
  }

  // ── enrollment (contract section 3) ──
  function enrollFail(copy) { return S.clear().then(function () { state.record = null; problem(copy) }, function () { problem(copy) }) }
  // Two taps, and each Face ID prompt is the FIRST thing its tap does: Safari allows a passkey call only
  // inside a fresh user gesture, so no network wait ever sits between a tap and its prompt.
  //   Tap 1: create the passkey, then make the device key (no prompt), commit to r, start, sign the proof.
  //   Tap 2: Face ID over the proof, then prove; the code on screen is the one this phone worked out.
  function onEnroll(ev) {
    if (!ev || ev.isTrusted !== true || state.busy) return undefined
    state.busy = true
    var subtle = W.crypto.subtle
    var labelEl = $('enroll-label')
    var label = (labelEl && String(labelEl.value || '').trim()) || 'iPhone'
    var c = {}
    setText('enroll-status', 'Create this phone’s approval passkey.')
    return W.navigator.credentials.create({
      publicKey: {
        rp: { id: W.location.hostname, name: 'COS Control' },
        user: { id: W.crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
        challenge: W.crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
        attestation: 'none', timeout: 120000,
      },
    }).then(null, function () { throw refusal('passkey_cancelled') }).then(function (cred) {
      var xy = cred && cred.response ? P.passkeyXY(cred.response) : null
      if (!xy) throw refusal('passkey_malformed')
      c.xy = xy
      c.credentialId = P.b64url(cred.rawId)
      setText('enroll-status', 'Making a key on this phone.')
      // The device key: non-extractable, made with no prompt of its own.
      return subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    }).then(function (pair) {
      c.pair = pair
      return subtle.exportKey('spki', pair.publicKey)
    }).then(function (spki) {
      c.spki = new Uint8Array(spki)
      c.r = W.crypto.getRandomValues(new Uint8Array(32))
      return P.sasCommit(c.r)
    }).then(function (commit) {
      return api('/api/web-key/enroll/start', { method: 'POST', body: { spki: P.b64url(c.spki), label: label, sasCommit: commit } })
    }).then(function (a) {
      if (a.status !== 201 || a.body.ok !== true) throw refusal(a.body.error || 'enroll_start_failed')
      c.start = a.body
      if (c.start.origin !== W.location.origin || c.start.rpId !== W.location.hostname) throw refusal('origin_mismatch')
      c.challenge = P.fromB64url(c.start.challenge)
      if (!c.challenge || c.challenge.length !== 32) throw refusal('challenge_invalid')
      return Promise.all([P.kidOf(c.spki), P.sasCode(c.challenge, c.spki, c.r), P.fingerprintOf(c.spki), P.sha256(P.spkiFromXY(c.xy.x, c.xy.y))])
    }).then(function (v) {
      if (v[0] !== c.start.kid) throw refusal('kid_mismatch')
      c.kid = v[0]; c.code = v[1]; c.fingerprint = v[2]
      c.record = { kid: c.kid, keyPair: c.pair, spki: P.b64url(c.spki), credentialId: c.credentialId, label: label, enrollId: c.start.enrollId, exp: c.start.exp, state: 'pending', code: c.code, fingerprint: c.fingerprint }
      c.msg = P.jcsBytes(P.enrollProofMessage({
        enrollId: c.start.enrollId, challenge: c.start.challenge, aud: c.start.aud, origin: W.location.origin, kid: c.kid,
        phoneNonce: P.b64url(c.r), passkeyCredentialId: c.credentialId, passkeySpkiSha256: P.hex(v[3]),
      }))
      return S.put(c.record)
    }).then(function () {
      return subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, c.pair.privateKey, c.msg)
    }).then(function (sig) {
      c.sig = new Uint8Array(sig)
      return P.sha256(c.msg)
    }).then(function (proofChallenge) {
      c.proofChallenge = proofChallenge
      state.enrolling = c
      setText('enroll-status', 'One more Face ID to finish.')
      var go = $('enroll-confirm'); if (go) go.hidden = false
      var first = $('enroll-start'); if (first) first.hidden = true
      return undefined
    }).catch(function (err) {
      return enrollFail(reasonCopy(err && err.reason ? err.reason : 'enroll_failed'))
    }).then(function () { state.busy = false })
  }
  function onEnrollConfirm(ev) {
    var c = state.enrolling
    if (!ev || ev.isTrusted !== true || state.busy || !c) return undefined
    state.busy = true
    state.enrolling = null
    var go = $('enroll-confirm'); if (go) go.hidden = true
    return assertWith(c.credentialId, c.proofChallenge).then(function (assertion) {
      setText('enroll-status', 'Checking with your Mac.')
      return api('/api/web-key/enroll/prove', { method: 'POST', body: {
        enrollId: c.start.enrollId, signature: P.b64url(c.sig), phoneNonce: P.b64url(c.r),
        passkey: { publicKey: P.b64url(P.coseFromXY(c.xy.x, c.xy.y)), credentialId: c.credentialId, assertion: assertion },
      } })
    }).then(function (a) {
      if (a.status !== 200 || a.body.ok !== true) throw refusal(a.body.error || 'enroll_prove_failed')
      // The code on this screen is the one this phone worked out. The Mac's copy must agree.
      if (a.body.sas !== c.code) return enrollFail('The code from your Mac does not match the code this phone worked out. Do not approve on the Mac. Start again.')
      state.record = c.record
      paintKey(c.record)
      state.busy = false
      return watchEnrollment(c.record)
    }).catch(function (err) {
      return enrollFail(reasonCopy(err && err.reason ? err.reason : 'enroll_failed'))
    }).then(function () { state.busy = false })
  }
  function watchEnrollment(rec) {
    setText('pending-code', spacedCode(rec.code))
    setText('pending-fingerprint', rec.fingerprint)
    show('pending')
    return new Promise(function (resolve) {
      var tick = function () {
        api('/api/web-key/enroll/status?enrollId=' + encodeURIComponent(rec.enrollId)).then(function (a) {
          var s = a.body && a.body.status
          if (s === 'enrolled') {
            rec.state = 'enrolled'
            return S.put(rec).then(function () { state.record = rec; setText('idle-text', 'This phone can approve messages now.'); show('idle'); resolve() })
          }
          if (s === 'started' || s === 'proven') { W.setTimeout(tick, POLL_MS); return undefined }
          return enrollFail(s === 'expired' ? 'Setup expired before the Mac approved it. Start again.' : 'Setup ended without approval. Start again.').then(resolve)
        }, function () { W.setTimeout(tick, POLL_MS) })
      }
      tick()
    })
  }

  // ── revoke this phone's key (no Touch ID needed, plan section 4.7) ──
  function onRevoke(ev) {
    if (!ev || ev.isTrusted !== true || !state.record) return undefined
    if (!state.revokeArmed) { state.revokeArmed = true; setText('key-revoke', 'Tap again to remove this phone’s key'); return undefined }
    state.revokeArmed = false
    var kid = state.record.kid
    return api('/api/web-key/revoke', { method: 'POST', body: { kid: kid, reason: 'revoked on the phone' } }).then(function (a) {
      if (a.status !== 200 && a.status !== 404) throw refusal(a.body.error || 'revoke_failed')
      return S.clear()
    }).then(function () { state.record = null; show('enroll') }, function (err) { problem(reasonCopy(err && err.reason)) })
  }

  function on(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn) }
  on('enroll-start', onEnroll)
  on('enroll-confirm', onEnrollConfirm)
  on('sign-approve', onApprove)
  on('sign-cancel', function (ev) { if (!ev || ev.isTrusted !== true || state.busy) return; state.handoff = null; state.nonce = null; problem('Approval cancelled. Nothing was signed or sent.'); })
  on('key-revoke', onRevoke)
  var back = $('back'); if (back) back.href = controlUrl()
  var back2 = $('done-back'); if (back2) back2.href = controlUrl()
  W.COSSigner = { ready: boot() }
})(window)
