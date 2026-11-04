/* COS Control Web: Speakers, the same pane as Control 0.5.366 (ActivityWindow.swift speakersList 3319-4325,
   voiceDirectoryDetail 5327-5431, held naming sheets 7363-7660; Views.swift SpeakerReviewPane 4642-6021;
   ControllerModel.swift 2487-2580, 9685-11500; Models.swift ReviewableMeeting, SpeakerReview, held naming).
   Three views: Meetings to review (default), Samples to review, Voices. Every write is the two-step Control
   uses: a dryRun or preview first, then confirm only from the card the person saw.
   Routes: #/speakers, #/speakers/samples, #/speakers/voices, #/speakers/review/<sessionId>,
   #/speakers/voice/<name>, #/speakers/voice/<name>/review/<sessionId>. */
(function () {
  'use strict';
  var W = window.COSWeb;
  if (!W) return;
  var $ = W.$, esc = W.esc;
  var pane = $('pane-speakers');
  var MEM_KEY = 'cos_web_speaker_memory', PREF_KEY = 'cos_web_speaker_prefs';
  var ROW_PAGE = 60;
  var VIEWS = [
    { id: 'meetings', title: 'Meetings to review', hero: 'Meetings to review' },
    { id: 'samples', title: 'Samples to review', hero: 'Samples to review' },
    { id: 'voices', title: 'Voices', hero: 'Voice directory' }
  ];
  var MEETING_SORTS = [['reviewPriority', 'Needs review first'], ['newest', 'Newest first'], ['oldest', 'Oldest first']];
  var VOICE_SORTS = [['attention', 'Needs attention'], ['recent', 'Recently heard'], ['meetings', 'Most meetings'],
    ['samples', 'Most samples'], ['confidence', 'Lowest confidence'], ['name', 'Name']];
  var PHONE_NOTE = 'iPhone microphone recordings are anonymous. Names and voice training are unavailable.';
  var READ_ONLY = 'This review is read-only or needs a newer server to verify the selected meeting. Reopen it after updating.';
  var EARLIER = 'An earlier correction on this meeting never finished, so its files may be part-written. Nothing was changed. Restart the COS server, then try again.';
  var FINALIZING = 'This meeting is still being saved. Try again in a minute.';
  var HELD_UPDATE = function (what) { return 'Update the COS server to 6.46.0 or newer to ' + what + '.'; };

  // ── small helpers ──────────────────────────────────────
  function str(v) { return typeof v === 'string' ? v : ''; }
  function int(v) {
    if (typeof v === 'number' && isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
    return null;
  }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function s(n) { return n === 1 ? '' : 's'; }
  function two(x) { return Number(x).toFixed(2); }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function icon(n) { return '<svg class="icon" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; }
  function isVoiceLabel(l) { return /^Voice [1-9][0-9]?$/.test(l || ''); }
  function isMac(sid) { return /^mac_/.test(sid || ''); }
  function isPhoneCapture(sid) { return /^phone_/.test(sid || ''); }
  function validHash(h) { return typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h); }
  // "13:02" reads as "1:02 PM"; anything that is not H:mm comes back untouched (ClockStyle.format).
  function clock12(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return hhmm || '';
    var h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return hhmm;
    return (h % 12 === 0 ? 12 : h % 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function mmss(ms) { var t = Math.round(ms / 1000); return Math.floor(t / 60) + 'm ' + (t % 60) + 's'; }
  function secs(seconds) { var t = Math.round(seconds); return Math.floor(t / 60) + 'm ' + (t % 60) + 's'; }
  function stamp(ms) { var t = Math.floor((ms || 0) / 1000); return Math.floor(t / 60) + ':' + pad2(t % 60); }
  function formatDuration(ms) {
    if (!(ms > 0)) return '0m';
    var minutes = Math.max(1, Math.round(ms / 60000));
    return minutes < 60 ? minutes + 'm' : Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }
  function spin() { return '<span class="sp-spin" aria-hidden="true"></span>'; }
  function hoverless() { try { return window.matchMedia('(hover: none)').matches; } catch (_e) { return false; } }
  // A server sentence written for an API caller ("pass { force: true }") is dropped whole (MacVoiceCopy.withoutForceJargon).
  function withoutForce(text, fallback) {
    if (!text) return fallback;
    return String(text).toLowerCase().split(/[^a-z]+/).indexOf('force') >= 0 ? fallback : text;
  }
  function serverMessage(body, status) {
    var b = body || {};
    return str(b.message) || str(b.error) || ('Request failed (' + status + ')');
  }

  // Every write reads its status and body: a 400 confirmation gate, a 409 refusal and a 422 decline carry the
  // explanation the card shows, so they are answers, not transport errors. Same headers as W.api.
  function call(method, path, body) {
    var headers = { 'X-COS-Web': '1' };
    var opts = { method: method, headers: headers, credentials: 'same-origin' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) {
        W.api('/api/voice/profiles').catch(function () {});
        var e = new Error('Signed out. Connect this browser again.'); e.status = 401; throw e;
      }
      if (res.status === 403) { var f = new Error('Unauthorized'); f.status = 403; throw f; }
      return res.text().then(function (t) {
        var b = null;
        try { b = t ? JSON.parse(t) : {}; } catch (_e) { b = null; }
        return { status: res.status, body: b };
      });
    }, function () { throw new Error('Server stopped'); });
  }
  // A read that must answer 200 (speakerReviewBody): anything else throws the server's own sentence.
  function read(path) {
    return call('GET', path).then(function (r) {
      if (r.status !== 200 || !r.body) { var e = new Error(serverMessage(r.body, r.status)); e.status = r.status; throw e; }
      return r.body;
    });
  }
  function sidPath(sid) { return '/api/meeting/' + encodeURIComponent(sid); }

  // ── local memory (SpeakerListMemory) and preferences ───
  function loadMem() {
    var m = W.readStore(MEM_KEY);
    return {
      acknowledged: Array.isArray(m.acknowledged) ? m.acknowledged.filter(function (x) { return typeof x === 'string'; }) : [],
      opened: Array.isArray(m.opened) ? m.opened.filter(function (x) { return typeof x === 'string'; }) : [],
      visits: m.visits && typeof m.visits === 'object' ? m.visits : {}
    };
  }
  var M = loadMem();
  function saveMem() {
    if (M.acknowledged.length > 600) M.acknowledged = M.acknowledged.slice(-600);
    if (M.opened.length > 600) M.opened = M.opened.slice(-600);
    var keys = Object.keys(M.visits);
    if (keys.length > 600) keys.slice(0, keys.length - 600).forEach(function (k) { delete M.visits[k]; });
    W.writeStore(MEM_KEY, M);
  }
  function seedIfEmpty(ids) { if (!M.acknowledged.length && ids.length) { M.acknowledged = ids.slice(); saveMem(); } }
  function isNew(sid) { return M.acknowledged.length > 0 && M.acknowledged.indexOf(sid) < 0; }
  function markOpened(sid) {
    if (M.acknowledged.indexOf(sid) < 0) M.acknowledged.push(sid);
    if (M.opened.indexOf(sid) < 0) M.opened.push(sid);
    saveMem();
  }
  function recordVisit(sid, voices, unattributed) {
    markOpened(sid);
    M.visits[sid] = { voices: voices, unattributedVoices: unattributed, humanTouched: true };
    saveMem();
  }
  // Server voiceReview is the truth; the visit overlay shows REVIEWED before the next list refresh.
  function voiceTag(m) {
    var v = M.visits[m.sessionId];
    var un = v && typeof v.unattributedVoices === 'number' ? v.unattributedVoices : m.unattributedVoices;
    var finished = (v && v.humanTouched === true) || m.humanTouched === true;
    if (typeof un === 'number' && un === 0 && finished) return { kind: 'reviewed' };
    if (typeof un === 'number' && un > 0) return { kind: 'needs', n: un };
    return null;
  }
  function reviewRank(m) {
    var t = voiceTag(m);
    if (t && t.kind === 'needs') return 0;
    if (!t) return isNew(m.sessionId) ? 1 : 2;
    return 3;
  }
  function ranked(list) {
    return list.slice().sort(function (a, b) {
      var ra = reviewRank(a), rb = reviewRank(b);
      if (ra !== rb) return ra - rb;
      if (a.date !== b.date) return a.date > b.date ? -1 : 1;
      return a.title.localeCompare(b.title, undefined, { numeric: true });
    });
  }
  function chronological(list, newest) {
    return list.slice().sort(function (a, b) {
      if (a.date !== b.date) return (a.date > b.date ? -1 : 1) * (newest ? 1 : -1);
      if (a.time !== b.time) {
        if (!a.time) return 1;
        if (!b.time) return -1;
        return (a.time > b.time ? -1 : 1) * (newest ? 1 : -1);
      }
      return a.title.localeCompare(b.title, undefined, { numeric: true });
    });
  }
  var prefs = W.readStore(PREF_KEY);
  var P = {
    hideReviewed: prefs.hideReviewed === true,
    sort: MEETING_SORTS.some(function (o) { return o[0] === prefs.sort; }) ? prefs.sort : 'reviewPriority'
  };
  function savePrefs() { W.writeStore(PREF_KEY, { hideReviewed: P.hideReviewed, sort: P.sort }); }

  // ── state ──────────────────────────────────────────────
  var S = {
    view: 'meetings',   // the Speaker view picker: window state, as in Control, never a route of its own
    meetings: null, meetingsLoading: false, meetingsError: '', refreshNeeded: false, pendingNew: 0, peekTimer: null,
    dir: null, dirLoading: false, dirError: '', dirLoadFailed: false, dirRoute: null, unresolvedMeetings: 0, unresolvedSegments: 0,
    voiceSearch: '', voiceSort: 'attention',
    profiles: null,
    H: null,     // Samples to review
    R: null      // the open review
  };
  function visibleMeetings() {
    var list = S.meetings || [];
    var ordered = P.sort === 'newest' ? chronological(list, true) : P.sort === 'oldest' ? chronological(list, false) : ranked(list);
    return P.hideReviewed ? ordered.filter(function (m) { var t = voiceTag(m); return !(t && t.kind === 'reviewed'); }) : ordered;
  }
  // Next to name walks the review queue, never the display sort.
  function nextUnnamed(after) {
    var queue = ranked(S.meetings || []).filter(function (m) { var t = voiceTag(m); return !(t && t.kind === 'reviewed'); });
    var i = -1;
    queue.forEach(function (m, n) { if (m.sessionId === after) i = n; });
    if (i < 0) return queue[0] || null;
    if (i + 1 < queue.length) return queue[i + 1];
    return queue.filter(function (m) { return m.sessionId !== after; })[0] || null;
  }

  // ── one shared player (Control's single AVAudioPlayer) ─
  var audio = new Audio();
  audio.preload = 'none';
  var A = { key: null, voice: null, missing: '', note: null };
  function stopPlayback() { A.key = null; A.voice = null; try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (_e) {} }
  // A second tap on what is already playing means stop.
  function play(key, voice, url, missing) {
    if (A.key === key) { stopPlayback(); render(); return; }
    stopPlayback();
    A.note = null; A.key = key; A.voice = voice; A.missing = missing;
    audio.src = url;
    var p = audio.play();
    if (p && p.catch) p.catch(function (err) {
      if (A.key !== key) return;
      if (err && err.name === 'AbortError') return;
      // A browser that refuses to start audio is not expired audio; say what is true.
      A.note = { voice: voice, text: err && err.name === 'NotAllowedError' ? 'This browser did not start the audio. Tap play again.' : missing };
      A.key = null; render();
    });
    render();
  }
  audio.addEventListener('ended', function () { A.key = null; render(); });
  audio.addEventListener('error', function () {
    if (!A.key) return;
    A.note = { voice: A.voice, text: A.missing }; A.key = null; render();
  });
  function noteFor(voice) { return A.note && A.note.voice === voice && !A.key ? A.note.text : ''; }

  // ── Meetings to review ─────────────────────────────────
  function parseMeeting(o) {
    if (!o || typeof o.sessionId !== 'string' || !o.sessionId) return null;
    var vr = o.voiceReview && typeof o.voiceReview === 'object' ? o.voiceReview : null;
    return {
      sessionId: o.sessionId, title: str(o.title) || 'Untitled meeting', date: str(o.date), time: str(o.time),
      domain: str(o.domain), duration: str(o.duration), month: str(o.month), filename: str(o.filename), source: str(o.source),
      topicCount: int(o.topicCount) || 0, decisionCount: int(o.decisionCount) || 0, actionCount: int(o.actionCount) || 0,
      attendeeCount: int(o.attendeeCount) || 0, recordId: str(o.recordId),
      voices: vr ? int(vr.voices) || 0 : null, unattributedVoices: vr ? int(vr.unattributedVoices) || 0 : null,
      namedVoices: vr ? int(vr.namedVoices) || 0 : null, humanTouched: vr ? vr.humanTouched === true : null
    };
  }
  function dateLine(m) { return [m.date, m.time ? clock12(m.time) : '', m.duration].filter(Boolean).join(' · '); }
  function countsSummary(m) {
    var parts = [];
    if (m.topicCount > 0) parts.push(m.topicCount + ' topic' + s(m.topicCount));
    if (m.decisionCount > 0) parts.push(m.decisionCount + ' decision' + s(m.decisionCount));
    if (m.actionCount > 0) parts.push(m.actionCount + ' action' + s(m.actionCount));
    if (m.attendeeCount > 0) parts.push(m.attendeeCount + ' attendee' + s(m.attendeeCount));
    return parts.length ? parts.join(' · ') : m.source;
  }
  function isG2Row(o) { return !str(o.derivedKind) && /g2|glasses/i.test(str(o.source)); }
  function skippedSentence(skipped, rows) {
    function label(r) { return r.date ? '"' + r.title + '" (' + r.date + ')' : '"' + r.title + '"'; }
    var g2 = rows.filter(function (r) { return r.isG2; }), other = rows.filter(function (r) { return !r.isG2; });
    var parts = [];
    if (other.length) {
      var sources = other.map(function (r) { return r.source; }).filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort().join(', ');
      parts.push(other.length + ' came from ' + (sources || 'another source') + ' and have no G2 audio to review');
    }
    if (g2.length) {
      parts.push(g2.length + ' G2 recording' + s(g2.length) + ' ' + (g2.length === 1 ? 'was' : 'were') + ' saved without a speaker sidecar, so identity review is not available: ' +
        g2.map(label).join('; ') + '. Send the meeting’s filename and date to support; this is not a server version problem');
    }
    if (!parts.length) return skipped + ' recent meeting(s) cannot be reviewed here. This is not a server version problem.';
    return skipped + ' recent meeting(s) cannot be reviewed here: ' + parts.join('; ') + '.';
  }
  function loadMeetings() {
    if (S.meetingsLoading) return;
    S.meetingsLoading = true;
    render();
    read('/api/meetings?limit=30').then(function (d) {
      var raw = Array.isArray(d.meetings) ? d.meetings : [];
      S.meetings = raw.map(parseMeeting).filter(Boolean);
      seedIfEmpty(S.meetings.map(function (m) { return m.sessionId; }));
      S.refreshNeeded = false; S.pendingNew = 0; S.meetingsError = '';
      if (!S.meetings.length) {
        var skippedRows = raw.filter(function (o) { return !parseMeeting(o); }).slice(0, 10).map(function (o) {
          return { title: str(o.title) || 'Untitled meeting', date: str(o.date), source: str(o.source), isG2: isG2Row(o) };
        });
        var skipped = raw.length;
        return read('/api/voice/directory?limit=100').then(function (dir) {
          return Array.isArray(dir.profiles) ? dir.profiles.length : null;
        }, function () { return null; }).then(function (enrolled) {
          if (enrolled === 0) S.meetingsError = 'No voices are enrolled yet, so every speaker is recorded as Ext and there is nothing to review. Name a held voice under Samples to review, or say "enroll my voice" on the glasses to record a 30-second sample.';
          else if (skipped > 0) S.meetingsError = skippedSentence(skipped, skippedRows);
        });
      }
    }).catch(function (err) {
      S.meetings = []; S.meetingsError = err.message || 'Meetings could not be loaded.';
    }).then(function () { S.meetingsLoading = false; render(); });
  }
  // Quiet poll: never replaces the list while someone works it, only sets the Refresh cue.
  function peek() {
    if (S.meetingsLoading || !S.meetings) return;
    read('/api/meetings?limit=30').then(function (d) {
      var loaded = {};
      S.meetings.forEach(function (m) { loaded[m.sessionId] = true; });
      var incoming = (Array.isArray(d.meetings) ? d.meetings : []).map(parseMeeting).filter(Boolean).filter(function (m) { return !loaded[m.sessionId]; });
      var changed = S.pendingNew !== incoming.length;
      S.pendingNew = incoming.length; S.refreshNeeded = incoming.length > 0;
      if (changed) render();
    }, function () {});
  }
  function syncPeek() {
    var r = W.parseRoute();
    var want = r.pane === 'speakers' && !r.args.length && S.view === 'meetings' && !document.hidden;
    if (want && !S.peekTimer) S.peekTimer = setInterval(peek, 45000);
    if (!want && S.peekTimer) { clearInterval(S.peekTimer); S.peekTimer = null; }
  }
  document.addEventListener('visibilitychange', syncPeek);
  function refreshTitle() {
    if (!S.refreshNeeded) return 'Refresh';
    if (S.pendingNew === 1) return 'Refresh · 1 new recording';
    if (S.pendingNew > 1) return 'Refresh · ' + S.pendingNew + ' new recordings';
    return 'Refresh needed';
  }

  // ── voice directory ────────────────────────────────────
  function parsePerson(o) {
    if (!o || typeof o.name !== 'string' || !o.name) return null;
    function counts(obj) { var out = {}; if (obj && typeof obj === 'object') Object.keys(obj).forEach(function (k) { out[k] = int(obj[k]) || 0; }); return out; }
    return {
      name: o.name, isOwner: o.isOwner === true, embeddings: int(o.embeddings) || 0, sources: counts(o.sources),
      sourcesAligned: o.sourcesAligned !== false, assertedSegments: int(o.assertedSegments) || 0,
      candidateSegments: int(o.candidateSegments) || 0, assertedSpeakingMs: int(o.assertedSpeakingMs) || 0,
      meetingCount: int(o.meetingCount) || 0, reviewMeetingCount: int(o.reviewMeetingCount) || 0,
      observedMatch: num(o.observedMatch), observedMatchSegments: int(o.observedMatchSegments) || 0,
      reliabilityCounts: counts(o.reliabilityCounts), firstSeen: str(o.firstSeen) || null, lastSeen: str(o.lastSeen) || null,
      appearances: (Array.isArray(o.appearances) ? o.appearances : []).map(function (a) {
        if (!a || typeof a.sessionId !== 'string' || !a.sessionId) return null;
        return { sessionId: a.sessionId, title: str(a.title) || 'Untitled meeting', date: str(a.date), segments: int(a.segments) || 0,
          speakingMs: int(a.speakingMs) || 0, observedMatch: num(a.observedMatch), confirmedByHuman: a.confirmedByHuman === true, needsReview: a.needsReview === true };
      }).filter(Boolean)
    };
  }
  function needsAttention(p) { return p.reviewMeetingCount > 0 || !p.sourcesAligned; }
  function loadDirectory(refresh) {
    if (S.dirLoading) return Promise.resolve();
    S.dirLoading = true;
    render();
    return call('GET', '/api/voice/directory?limit=100' + (refresh ? '&refresh=1' : '')).then(function (r) {
      if (r.status === 404) {
        return read('/api/voice/profiles').then(function (b) {
          S.dir = (Array.isArray(b.profiles) ? b.profiles : []).map(parsePerson).filter(Boolean);
          S.dirRoute = false; S.unresolvedMeetings = 0; S.unresolvedSegments = 0;
        });
      }
      if (r.status !== 200 || !r.body) throw new Error(str(r.body && r.body.error) || 'Request failed (' + r.status + ')');
      S.dir = (Array.isArray(r.body.profiles) ? r.body.profiles : []).map(parsePerson).filter(Boolean);
      S.dirRoute = true;
      S.unresolvedMeetings = int(r.body.unresolvedMeetings) || 0;
      S.unresolvedSegments = int(r.body.unresolvedSegments) || 0;
    }).then(function () { S.dirError = ''; S.dirLoadFailed = false; }, function (err) {
      // Last-good rows stay; a failed first load is not "nobody enrolled".
      S.dirError = err.message || 'The helper did not answer.';
      S.dirLoadFailed = !S.dir || !S.dir.length;
    }).then(function () { S.dirLoading = false; render(); });
  }
  function loadProfiles() {
    return read('/api/voice/profiles').then(function (b) {
      S.profiles = (Array.isArray(b.profiles) ? b.profiles : []).map(function (p) {
        return p && typeof p.name === 'string' ? { name: p.name, embeddings: int(p.embeddings) || 0, isOwner: p.isOwner === true } : null;
      }).filter(Boolean);
    }, function () { S.profiles = []; });
  }

  // ── Samples to review: held voices ─────────────────────
  function newHeld() {
    return {
      loading: false, extSessions: [], extError: '', extLoadFailed: false,
      state: null, error: '', groups: [], loose: [], pending: 0, samples: 0, embedded: 0, unusable: 0, speakerModel: true,
      namingAvailable: false, batches: [], historyError: '', busy: false, result: '', generation: 0,
      naming: null, typed: '', confirmDiscard: null, cursor: {}, shown: ROW_PAGE,
      preview: null, members: [], ownerAck: false, listened: false, revised: '',
      sheet: null, receipt: null, confirmUndo: null
    };
  }
  function parseRef(o) {
    if (!o || typeof o.sessionId !== 'string' || !o.sessionId) return null;
    var c = int(o.chunkIndex);
    if (c == null || c < 0) return null;
    var sg = o.suggestion && typeof o.suggestion === 'object' && str(o.suggestion.name) ? {
      name: o.suggestion.name, similarity: num(o.suggestion.similarity) || 0, tier: str(o.suggestion.tier) || 'likely',
      agreeing: int(o.suggestion.agreeing) || 0, ownerCaution: o.suggestion.ownerCaution === true } : null;
    return { sessionId: o.sessionId, chunkIndex: c, suggestion: sg, id: o.sessionId + '#' + c };
  }
  function parseGroup(o) {
    if (!o || typeof o.id !== 'string' || !o.id) return null;
    var members = (Array.isArray(o.members) ? o.members : []).map(parseRef).filter(Boolean);
    if (!members.length) return null;
    var seed = parseRef(o.seed) || members[0];
    var sg = o.suggestion && typeof o.suggestion === 'object' ? o.suggestion : null;
    return {
      id: o.id, members: members, sessions: (Array.isArray(o.sessions) ? o.sessions : []).filter(function (x) { return typeof x === 'string'; }),
      sampleCount: int(o.sampleCount) || members.length, seed: seed,
      playOrder: [seed].concat(members.filter(function (m) { return m.id !== seed.id; })),
      suggestionName: sg && str(sg.name) ? sg.name : null, suggestionSimilarity: sg ? num(sg.similarity) || 0 : 0,
      suggestionTier: sg ? str(sg.tier) : '', suggestionAgreeing: sg ? int(sg.agreeing) || 0 : 0, suggestionOf: sg ? int(sg.of) || 0 : 0,
      ownerCaution: !!(sg && sg.ownerCaution === true)
    };
  }
  function namingSupported(body) {
    var c = body && body.namingCapabilities;
    return !!(c && c.version === 1 && c.preview === true && c.apply === true && c.undo === true);
  }
  function heldUsable(H) { return H.state === 'ready' && !(H.embedded === 0 && H.samples > 0); }
  function loadHeld() {
    var H = S.H;
    if (H.loading) return Promise.resolve();
    H.loading = true; H.extError = ''; H.extLoadFailed = false;
    render();
    var ext = call('GET', '/api/voice/ext-audio').then(function (r) {
      if (r.status === 404) { H.extSessions = []; H.extError = 'Update the COS server to add a voice from here.'; return; }
      if (r.status !== 200 || !r.body) throw new Error('Request failed (' + r.status + ')');
      H.extSessions = (Array.isArray(r.body.sessions) ? r.body.sessions : []).map(function (o) {
        if (!o || typeof o.sessionId !== 'string' || !o.sessionId) return null;
        return { sessionId: o.sessionId, chunks: int(o.chunks) || 0, expiresIn: str(o.expiresIn),
          chunkIndices: (Array.isArray(o.chunkIndices) ? o.chunkIndices : []).map(int).filter(function (n) { return n != null && n >= 0; }).sort(function (a, b) { return a - b; }) };
      }).filter(Boolean);
      if (!H.extSessions.length) H.extError = 'No unrecognized audio is being held. Record a meeting first, then come back within 72 hours.';
    }).catch(function (err) { H.extSessions = []; H.extError = err.message; H.extLoadFailed = true; });
    return ext.then(loadHeldGroups).then(function () {
      H.loading = false; render();
      // The directory's names back the "Adds to" hint while naming a voice.
      if (!S.dir && !S.dirLoading) loadDirectory(false);
    });
  }
  function loadHeldGroups() {
    var H = S.H;
    H.error = '';
    return call('GET', '/api/voice/held-groups').then(function (r) {
      if (r.status === 404) {
        H.state = 'route_absent'; H.groups = []; H.loose = []; H.pending = 0; H.namingAvailable = false; return null;
      }
      if (r.status !== 200 || !r.body) throw new Error('Request failed (' + r.status + ')');
      var b = r.body;
      H.state = 'ready';
      H.groups = (Array.isArray(b.groups) ? b.groups : []).map(parseGroup).filter(Boolean);
      H.loose = (Array.isArray(b.loose) ? b.loose : []).map(parseRef).filter(Boolean);
      H.pending = int(b.pending) || 0; H.samples = int(b.samples) || 0; H.embedded = int(b.embedded) || 0;
      H.unusable = int(b.unusable) || 0; H.speakerModel = b.speakerModel !== false;
      H.namingAvailable = namingSupported(b);
      if (H.namingAvailable) return loadBatches(true);
      H.batches = []; H.preview = null; if (H.sheet === 'preview') H.sheet = null;
      return null;
    }).catch(function (err) {
      H.state = 'error'; H.namingAvailable = false; H.groups = []; H.loose = []; H.pending = 0; H.error = err.message;
    });
  }
  // Naming is its own capability: probe it before EVERY write, so an older enroll route never applies a preview.
  function requireNaming() {
    return call('GET', '/api/voice/held-groups').then(function (r) {
      if (r.status !== 200 || !namingSupported(r.body)) throw new Error(HELD_UPDATE('preview, apply and undo meeting labels'));
    });
  }
  function loadBatches(probed) {
    var H = S.H;
    if (!H.namingAvailable) return Promise.resolve();
    return (probed ? Promise.resolve() : requireNaming()).then(function () {
      return call('GET', '/api/voice/held-groups/batches');
    }).then(function (r) {
      if (r.status !== 200 || !r.body) throw new Error('Interrupted naming history could not be read. Refresh to retry.');
      H.batches = (Array.isArray(r.body.batches) ? r.body.batches : []).map(parseBatch).filter(Boolean);
      H.historyError = '';
    }).catch(function (err) { H.historyError = err.message; });
  }
  function parseNamingMeeting(o) {
    if (!o || typeof o.sessionId !== 'string' || !o.sessionId) return null;
    var named = (Array.isArray(o.namedChunks) ? o.namedChunks : []).map(int).filter(function (n) { return n != null; });
    var wider = (Array.isArray(o.widerChunks) ? o.widerChunks : []).map(int).filter(function (n) { return n != null; });
    var copies = Array.isArray(o.receipts) ? o.receipts : Array.isArray(o.copies) ? o.copies : [];
    var status = str(o.status) || 'unknown';
    return {
      sessionId: o.sessionId, status: status, error: str(o.error) || null, named: named, wider: wider,
      labelled: int(o.labelled) != null ? int(o.labelled) : named.length + wider.length,
      roomRisk: o.roomRisk === true, labelsNewerThanGraph: o.labelsNewerThanGraph === true,
      playback: (Array.isArray(o.playback) ? o.playback : []).map(function (p) {
        if (!p || typeof p.sessionId !== 'string' || !p.sessionId) return null;
        var c = int(p.chunkIndex), pos = int(p.position);
        if (c == null || c < 0 || pos == null || pos < 0) return null;
        return { sessionId: p.sessionId, chunkIndex: c, position: pos, id: p.sessionId + '#' + c + '#' + pos };
      }).filter(Boolean),
      widerScores: Array.isArray(o.widerScores) ? o.widerScores : [],
      copySummaries: copies.map(function (c) {
        if (!c || typeof c.copy !== 'string') return null;
        return c.copy + ': ' + (str(c.status) || status) + (str(c.error) ? ', ' + c.error : '');
      }).filter(Boolean)
    };
  }
  function parseOutcomes(arr) {
    return (Array.isArray(arr) ? arr : []).map(function (o) {
      var ref = parseRef(o);
      if (!ref) return null;
      var labelStatus = str(o.labelStatus) || 'unknown', status = str(o.status) || 'unknown';
      return { sample: ref, status: status, enrollmentStatus: str(o.enrollmentStatus) || 'unknown', labelStatus: labelStatus,
        audioStatus: str(o.audioStatus) || 'unknown', reason: str(o.reason) || null,
        noTranscript: labelStatus === 'no_transcript_position' || status === 'no_transcript_position' };
    }).filter(Boolean);
  }
  function parseReceipt(raw, status) {
    var b = raw || {};
    var exp = null;
    if (typeof b.expiresAt === 'number') exp = new Date(b.expiresAt);
    else if (typeof b.expiresAt === 'string') { var d = new Date(b.expiresAt); exp = isNaN(d.getTime()) ? null : d; }
    var meetings = (Array.isArray(b.meetings) ? b.meetings : []).map(parseNamingMeeting).filter(Boolean);
    var membersRaw = Array.isArray(b.members) ? b.members : [];
    var R = {
      raw: b, httpStatus: status, kind: str(b.kind) || 'unknown', speaker: str(b.speaker) || str(b.name) || 'Voice',
      previewHash: str(b.previewHash) || null, expiresAt: exp, owner: b.owner === true, ownerWarning: str(b.ownerWarning) || null,
      requiresListening: b.requiresListening === true, meetings: meetings, batchId: str(b.batchId) || null,
      undoHandle: str(b.undoHandle) || null, members: membersRaw.map(parseRef).filter(Boolean),
      enrolled: int(b.enrolled) || 0, deleted: int(b.deleted) || 0, profileEmbeddings: int(b.profileEmbeddings),
      partial: b.partial === true, outcomes: parseOutcomes(membersRaw), error: str(b.error) || null, lockMode: str(b.lockMode)
    };
    R.eligible = membersRaw.filter(function (m) { return m && (m.status === 'ready' || m.status === 'no_transcript_position'); }).length;
    R.noTranscript = R.outcomes.filter(function (o) { return o.noTranscript; }).length;
    R.labelled = meetings.filter(function (m) { return m.status === 'ready' || m.status === 'applied'; }).reduce(function (a, m) { return a + m.labelled; }, 0);
    R.restored = meetings.filter(function (m) { return m.status === 'reverted'; }).reduce(function (a, m) { return a + m.labelled; }, 0);
    R.canApplyBase = R.kind === 'preview' && status === 200 && R.eligible > 0 && validHash(R.previewHash) && !!R.expiresAt && R.expiresAt > new Date();
    return R;
  }
  function parseBatch(o) {
    if (!o || typeof o.batchId !== 'string' || !o.batchId) return null;
    var status = str(o.status) || 'unknown';
    return { batchId: o.batchId, speaker: str(o.speaker) || 'Voice', status: status, undoHandle: str(o.undoHandle) || null,
      meetings: (Array.isArray(o.meetings) ? o.meetings : []).map(parseNamingMeeting).filter(Boolean),
      needsReview: status === 'interrupted' || status === 'partial' };
  }
  function membersPayload(members) {
    var seen = {}, out = [];
    members.forEach(function (m) {
      if (!m.sessionId || /[\/\\]|\.\./.test(m.sessionId) || !(m.chunkIndex >= 0)) return;
      var k = m.sessionId + '#' + m.chunkIndex;
      if (!seen[k]) { seen[k] = true; out.push({ sessionId: m.sessionId, chunkIndex: m.chunkIndex }); }
    });
    return out;
  }
  // 400, 404 with a reason, 409, 422 and 503 are review states that carry a receipt; never erase their body.
  function namingRequest(path, payload) {
    return requireNaming().then(function () { return call('POST', path, payload); }).then(function (r) {
      if (r.status === 404 && !(r.body && r.body.reason)) throw new Error(HELD_UPDATE('preview, apply and undo meeting labels'));
      if (!r.body) throw new Error('Server returned no naming receipt');
      if ([200, 400, 404, 409, 422, 503].indexOf(r.status) < 0) throw new Error(str(r.body.error) || 'Naming failed (' + r.status + ')');
      var message = str(r.body.message) || str(r.body.error) || (r.status === 200 ? 'Naming receipt ready' : 'Naming refused (' + r.status + ')');
      return { message: message, receipt: parseReceipt(r.body, r.status) };
    }, function (err) {
      if (err && err.message === 'Server stopped') throw new Error('Server stopped. Refresh to review any interrupted naming before retrying.');
      throw err;
    });
  }
  function canApply(H) {
    var p = H.preview;
    if (!H.namingAvailable || !H.speakerModel || H.busy || !p || !p.canApplyBase || !(p.expiresAt > new Date())) return false;
    return (!p.owner || H.ownerAck) && (!p.requiresListening || H.listened);
  }
  function nameHeld(members, name) {
    var H = S.H;
    if (members.some(function (m) { return isPhoneCapture(m.sessionId); })) { H.result = PHONE_NOTE; render(); return Promise.resolve(); }
    var trimmed = String(name || '').trim();
    if (!H.namingAvailable) { H.result = 'Update the COS server to 6.46.0 or newer to preview and apply meeting labels.'; render(); return Promise.resolve(); }
    if (trimmed.length < 2) { H.result = 'A name needs at least two characters.'; render(); return Promise.resolve(); }
    if (!members.length || H.busy) return Promise.resolve();
    H.busy = true; H.result = ''; H.preview = null; H.members = members; H.ownerAck = false; H.listened = false;
    render();
    return namingRequest('/api/voice/held-groups/enroll', { name: trimmed, members: membersPayload(members) }).then(function (out) {
      H.result = out.message;
      if (out.receipt.httpStatus === 200 && out.receipt.kind === 'preview') {
        H.preview = out.receipt; H.revised = out.receipt.speaker; H.sheet = 'preview'; H.naming = null; H.typed = '';
      }
    }, function (err) { H.result = err.message; }).then(function () { H.busy = false; render(); });
  }
  function applyHeld() {
    var H = S.H, p = H.preview;
    if (p && p.expiresAt && p.expiresAt <= new Date()) { H.result = 'The preview expired. Preview this naming again.'; cancelPreview(); render(); return; }
    if (!canApply(H)) return;
    H.busy = true; render();
    var payload = { name: p.speaker, members: membersPayload(H.members), previewHash: p.previewHash, confirm: true };
    if (H.ownerAck) payload.ownerAck = true;
    if (H.listened) payload.listened = true;
    namingRequest('/api/voice/held-groups/enroll', payload).then(function (out) {
      var rc = out.receipt;
      H.result = out.message;
      if (rc.kind === 'applied') {
        H.result = rc.enrolled + ' samples enrolled · ' + rc.labelled + ' segments labelled.' + (rc.partial ? ' Some meetings need review.' : '');
        H.receipt = rc; H.preview = null; H.sheet = null; H.naming = null; H.generation++; H.cursor = {}; H.confirmDiscard = null;
        stopPlayback();
        H.busy = false;
        return loadHeld().then(function () { S.dir = null; return loadDirectory(true); });
      }
      // A changed hash, sync lock or owner check never leaves a stale Apply armed.
      H.preview = null; H.sheet = null; H.receipt = rc;
      return loadBatches(false);
    }, function (err) {
      H.result = err.message; H.preview = null; H.sheet = null;
      return loadBatches(false);
    }).then(function () { H.busy = false; render(); });
  }
  function cancelPreview() {
    var H = S.H;
    if (H.busy) return;
    H.preview = null; H.ownerAck = false; H.listened = false;
    if (H.sheet === 'preview') H.sheet = null;
    stopPlayback();
  }
  function resumeHeld(batch) {
    var H = S.H;
    if (!H.namingAvailable || H.busy) return;
    H.busy = true; H.sheet = null; render();
    namingRequest('/api/voice/held-groups/resume', { batchId: batch.batchId, confirm: true }).then(function (out) {
      H.result = out.message;
      var rc = out.receipt;
      if (rc.httpStatus === 200 && rc.kind === 'preview') {
        H.members = rc.members; H.ownerAck = false; H.listened = false; H.preview = rc; H.revised = rc.speaker; H.sheet = 'preview';
      } else { H.receipt = rc; }
    }, function (err) { H.result = err.message; }).then(function () { H.busy = false; render(); });
  }
  // Undo relies on the persisted batch receipt, never on still-held audio.
  function undoHeld(handle) {
    var H = S.H;
    if (!H.namingAvailable || H.busy) return;
    H.busy = true; H.confirmUndo = null; render();
    namingRequest('/api/voice/held-groups/undo', { batchId: handle, confirm: true }).then(function (out) {
      var rc = out.receipt;
      H.result = out.message; H.receipt = rc;
      if (rc.kind === 'undone') {
        H.result = rc.restored + ' segments restored. Voice samples stay enrolled; deleted audio stays deleted.' + (rc.partial ? ' Some copies still need review.' : '');
      }
      H.preview = null; stopPlayback();
      return loadBatches(false).then(function () { S.dir = null; return loadDirectory(true); });
    }, function (err) { H.result = err.message; }).then(function () { H.busy = false; render(); });
  }
  // Discard throws the audio out for good, in slices of 200, and says how many went if a later slice fails.
  function discardHeld(members) {
    var H = S.H;
    if (!members.length || H.busy) return;
    H.busy = true; H.result = ''; render();
    var removed = 0, slice = 0;
    function next() {
      if (slice >= members.length) return Promise.resolve();
      var batch = members.slice(slice, slice + 200);
      return call('POST', '/api/voice/held-groups/discard', { members: membersPayload(batch), confirm: true }).then(function (r) {
        if (r.status === 404 && !(r.body && r.body.reason)) throw new Error(HELD_UPDATE('name held voices by group'));
        if (!r.body) throw new Error('Server stopped');
        if (r.status !== 200) throw new Error(str(r.body.error) || str(r.body.message) || 'Request failed (' + r.status + ')');
        removed += int(r.body.removed) || 0;
        slice += batch.length;
        return next();
      });
    }
    next().then(function () {
      H.result = 'Discarded ' + removed + ' held sample' + s(removed) + '.';
    }, function (err) {
      H.result = removed > 0 ? 'Discarded ' + removed + ' of ' + members.length + ' samples before an error: ' + err.message : err.message;
    }).then(function () {
      H.busy = false;
      if (removed > 0) { H.generation++; H.cursor = {}; H.confirmDiscard = null; stopPlayback(); return loadHeld(); }
      render();
    });
  }
  // "Sep 12, 3:41 PM · chunk 9" for a meeting_<ms>_<rand> session, else the raw id.
  function heldLabel(sessionId, chunk) {
    var parts = String(sessionId).split('_');
    var ms = Number(parts[1]);
    if (parts.length >= 2 && parts[0] === 'meeting' && ms > 1e12) {
      var d = new Date(ms);
      var t = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return chunk == null ? t : t + ' · chunk ' + chunk;
    }
    return chunk == null ? sessionId : sessionId + ' · chunk ' + chunk;
  }
  function extSampleUrl(ref) { return '/api/voice/ext-audio/' + encodeURIComponent(ref.sessionId) + '/sample?chunk=' + ref.chunkIndex; }

  // ── the review model (SpeakerReview, ReviewVoice) ──────
  var KINDS = ['anonymous-group', 'unresolved', 'preserved-anonymous'];
  function parseVoice(o) {
    if (!o || typeof o.label !== 'string') return null;
    var kind = KINDS.indexOf(o.kind) >= 0 ? o.kind : null;
    var placeholder = !!kind;
    var v = {
      label: o.label, segments: int(o.segments) || 0, speakingMs: int(o.speakingMs), meanSimilarity: num(o.meanSimilarity),
      isOwner: o.isOwner === true,
      reliability: placeholder ? 'unattributed' : (['confident', 'weak', 'unreliable', 'unattributed'].indexOf(o.reliability) >= 0 ? o.reliability : 'weak'),
      nameAsserted: placeholder ? false : o.nameAsserted !== false,
      blockers: (Array.isArray(o.assertionBlockers) ? o.assertionBlockers : []).filter(function (x) { return typeof x === 'string'; }),
      confirmedByHuman: o.confirmedByHuman === true,
      thrash: (Array.isArray(o.thrashesWith) ? o.thrashesWith : []).filter(function (t) { return t && typeof t.speaker === 'string'; })
        .map(function (t) { return { speaker: t.speaker, meanRun: num(t.meanRun) || 0 }; }),
      phrases: (Array.isArray(o.phrases) ? o.phrases : []).filter(function (p) { return p && typeof p.text === 'string' && p.text; })
        .map(function (p) { return { text: p.text, atMs: int(p.atMs) || 0, chunkIndex: int(p.chunkIndex) }; }),
      kind: null, identityId: null, wordCount: int(o.wordCount)
    };
    if (kind === 'anonymous-group' && /^Anonymous group [1-9][0-9]{0,5}$/.test(v.label) && str(o.identityId)) { v.kind = kind; v.identityId = o.identityId; }
    else if (kind === 'unresolved' && v.label === 'Ext') v.kind = kind;
    else if (kind === 'preserved-anonymous' && (/^Unidentified /.test(v.label) || isVoiceLabel(v.label))) v.kind = kind;
    v.displayName = v.kind === 'anonymous-group' || v.kind === 'preserved-anonymous' ? v.label
      : v.kind === 'unresolved' ? 'Unresolved speech'
      : (v.nameAsserted || isVoiceLabel(v.label) ? v.label : 'Unidentified voice');
    v.canRename = !v.isOwner && v.kind !== 'anonymous-group' && v.kind !== 'unresolved';
    v.isNameAssignment = v.reliability === 'unattributed';
    v.rank = v.isNameAssignment ? 0 : (!v.nameAsserted ? 1 : 2);
    v.canConfirmCandidate = !v.isOwner && !v.nameAsserted && v.reliability !== 'unattributed' && !v.confirmedByHuman;
    v.confirmsInOneClick = (v.meanSimilarity || 0) >= 0.65;
    v.canDeattribute = v.reliability !== 'unattributed';
    return v;
  }
  function unnamedCount(labels) {
    var voices = labels.filter(isVoiceLabel).length;
    return voices > 0 ? voices : labels.length;
  }
  function parseSummary(o, voices) {
    if (!o || typeof o !== 'object' || o.version !== 1 || o.basis !== 'source-bound-hq-words') return null;
    var keys = ['anonymousGroupCount', 'preservedAnonymousGroupCount', 'namedVoiceCount', 'withheldNameCount', 'unresolvedSpeakingMs', 'unresolvedWordCount'];
    if (keys.some(function (k) { return int(o[k]) == null || int(o[k]) < 0; })) return null;
    var g = int(o.anonymousGroupCount), named = int(o.namedVoiceCount), pre = int(o.preservedAnonymousGroupCount), wh = int(o.withheldNameCount);
    var parts = [g + ' estimated ' + (g === 1 ? 'group' : 'groups')];
    if (named > 0) parts.push(named + ' named ' + (named === 1 ? 'voice' : 'voices'));
    if (pre > 0) parts.push(pre + ' reviewed unnamed ' + (pre === 1 ? 'group' : 'groups'));
    if (wh > 0) parts.push(wh + ' withheld ' + (wh === 1 ? 'name' : 'names'));
    var words = int(o.unresolvedWordCount);
    return { header: parts.join(' · '), unresolvedNote: words > 0 ? 'Unresolved speech: ' + words + ' words · ' + Math.round(int(o.unresolvedSpeakingMs) / 1000) + 's' : null };
  }
  function parseHint(o) {
    if (!o || o.source !== 'speaker-shadow' || int(o.foldUnderSeconds) !== 15 || !str(o.recordedAt)
      || !Array.isArray(o.groups) || !Array.isArray(o.singles) || !Array.isArray(o.short)) return null;
    function sec(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null; }
    return {
      groups: o.groups.map(function (g) {
        var labels = g && Array.isArray(g.labels) ? g.labels.filter(function (x) { return typeof x === 'string'; }) : [];
        return g && str(g.id) && labels.length ? { id: g.id, labels: labels, seconds: sec(g.seconds) } : null;
      }).filter(Boolean),
      singles: o.singles.map(function (g) { return g && typeof g.label === 'string' ? { label: g.label, seconds: sec(g.seconds) } : null; }).filter(Boolean),
      short: o.short.map(function (g) {
        var x = g ? sec(g.seconds) : null;
        return g && typeof g.label === 'string' && x != null && x < 15 ? { label: g.label, seconds: x } : null;
      }).filter(Boolean)
    };
  }
  function rowTitle(labels) { return labels.length === 1 ? labels[0] : labels[0] + ' and ' + (labels.length - 1) + ' more'; }
  function parseReview(o) {
    if (!o || typeof o.sessionId !== 'string') return null;
    var sid = o.sessionId, mac = isMac(sid);
    var voices = (Array.isArray(o.voices) ? o.voices : []).map(parseVoice).filter(Boolean);
    var interval = ['effectiveSpeakerSummary', 'intervalGroupScopes', 'intervalHumanAnnotation', 'intervalHumanRecoveryRequired', 'intervalOriginalViewAvailable']
      .some(function (k) { return o[k] !== undefined; })
      || (Array.isArray(o.voices) ? o.voices : []).some(function (v) { return v && KINDS.indexOf(v.kind) >= 0; })
      || !!(o.speakerCallView && o.speakerCallView.mode === 'source-bound-intervals');
    var rv = {
      sessionId: sid, title: str(o.title) || 'Untitled meeting', segments: int(o.segments) || 0, attributed: o.attributed === true,
      assertedSegments: int(o.assertedSegments), attributedSpeakingMs: int(o.attributedSpeakingMs), unattributedSpeakingMs: int(o.unattributedSpeakingMs),
      speakingTimeSource: str(o.speakingTimeSource), durationMs: int(o.durationMs) || 0, voices: voices, intervalReadOnly: interval,
      summary: mac ? parseSummary(o.effectiveSpeakerSummary, voices) : null,
      timeline: (Array.isArray(o.timeline) ? o.timeline : []).map(function (t, i) {
        return t && typeof t.speaker === 'string' ? { speaker: t.speaker, startMs: int(t.startMs) || 0, endMs: int(t.endMs) || 0, segments: int(t.segments) || 0, index: i } : null;
      }).filter(Boolean),
      recordId: str(o.recordId), sourceRevision: str(o.sourceRevision) || null, identityVersion: int(o.reviewIdentityVersion),
      mutable: !interval && o.mutable !== false, domain: str(o.domain), filename: str(o.filename),
      groupScopeLabels: (Array.isArray(o.groupScopes) ? o.groupScopes : []).map(function (g) { return g && str(g.displayLabel); }).filter(Boolean),
      isMac: mac, callViewApplied: !!(o.speakerCallView && o.speakerCallView.status === 'applied'),
      hint: mac ? parseHint(o.voiceDisplay) : null
    };
    rv.byLabel = {};
    voices.forEach(function (v) { rv.byLabel[v.label] = v; });
    rv.unnamed = unnamedCount(voices.filter(function (v) { return v.isNameAssignment; }).map(function (v) { return v.label; }));
    var a = rv.attributedSpeakingMs, u = rv.unattributedSpeakingMs;
    rv.coverage = a != null && u != null && a + u > 0 ? a / (a + u) : null;
    rv.namedTotal = voices.reduce(function (t, v) { return t + (v.nameAsserted ? (v.speakingMs || 0) : 0); }, 0);
    rv.ordered = voices.map(function (v, i) { return { v: v, i: i }; }).sort(function (x, y) {
      if (x.v.rank !== y.v.rank) return x.v.rank - y.v.rank;
      if (x.v.segments !== y.v.segments) return y.v.segments - x.v.segments;
      return x.i - y.i;
    }).map(function (x) { return x.v; });
    rv.canSuggest = mac && rv.mutable && !!rv.recordId && validHash(rv.sourceRevision);
    rv.layout = buildLayout(rv);
    return rv;
  }
  function shareOf(rv, v) {
    if (!v.nameAsserted || v.speakingMs == null) return null;
    if (rv.coverage == null || rv.coverage < 0.6 || !(rv.namedTotal > 0)) return null;
    return v.speakingMs / rv.namedTotal;
  }
  function assertsName(rv, label) { var v = rv.byLabel[label]; return !!(v && v.nameAsserted); }
  function displayNameOf(rv, label) { var v = rv.byLabel[label]; return v ? v.displayName : label; }
  function canNameAlone(rv, v) {
    return rv.mutable && rv.isMac && v.canRename && isVoiceLabel(v.label) && rv.groupScopeLabels.indexOf(v.label) < 0;
  }
  // VoiceDisplayLayout: merged rows first, then singles and the rows that sit where they did, then one fold under 15 seconds.
  function buildLayout(rv) {
    var hint = rv.hint;
    if (!rv.isMac || rv.intervalReadOnly || rv.summary || rv.callViewApplied || !hint) return null;
    var ordered = rv.ordered;
    var labels = ordered.map(function (v) { return v.label; });
    if (labels.some(function (l, i) { return labels.indexOf(l) !== i; })) return null;
    var used = {}, seconds = {}, ids = {};
    function take(label) {
      if (!isVoiceLabel(label) || !rv.byLabel[label] || used[label]) return null;
      used[label] = true; return rv.byLabel[label];
    }
    var merged = [], singles = [], short = [];
    hint.groups.forEach(function (g) {
      var members = g.labels.map(take).filter(Boolean);
      if (members.length >= 2) {
        var id = 'group:' + (ids[g.id] ? members[0].label : g.id);
        ids[g.id] = true;
        merged.push({ id: id, members: members, seconds: members.length === g.labels.length ? g.seconds : null });
      } else if (members.length === 1) singles.push({ v: members[0], seconds: null });
    });
    hint.singles.forEach(function (x) { var v = take(x.label); if (v) { singles.push({ v: v, seconds: x.seconds }); if (x.seconds != null) seconds[v.label] = x.seconds; } });
    hint.short.forEach(function (x) { var v = take(x.label); if (v) { short.push({ v: v, seconds: x.seconds }); seconds[v.label] = x.seconds; } });
    function rank(a, b) { return (b == null ? -1 : b) - (a == null ? -1 : a); }
    merged = merged.map(function (m, i) { return { m: m, i: i }; }).sort(function (a, b) {
      if (a.m.seconds !== b.m.seconds) return rank(a.m.seconds, b.m.seconds);
      if (a.m.members.length !== b.m.members.length) return b.m.members.length - a.m.members.length;
      return a.i - b.i;
    }).map(function (x) { return x.m; });
    singles = singles.map(function (m, i) { return { m: m, i: i }; }).sort(function (a, b) {
      return a.m.seconds !== b.m.seconds ? rank(a.m.seconds, b.m.seconds) : a.i - b.i;
    }).map(function (x) { return x.m.v; });
    short = short.map(function (m, i) { return { m: m, i: i }; }).sort(function (a, b) {
      return a.m.seconds !== b.m.seconds ? b.m.seconds - a.m.seconds : a.i - b.i;
    }).map(function (x) { return x.m.v; });
    var rest = ordered.filter(function (v) { return !used[v.label]; });
    var rows = merged.map(function (m) { return { merged: m }; }).concat(singles.concat(rest).map(function (v) { return { voice: v }; }));
    return { rows: rows, short: short, seconds: seconds, visibleRowCount: rows.length + (short.length ? 1 : 0) };
  }
  function inventoryHeader(rv) {
    if (rv.layout) {
      var n = rv.layout.visibleRowCount;
      return rv.segments + ' segments · ' + (rv.voices.length === 1 ? '1 voice label' : rv.voices.length + ' voice labels') + ' in ' + n + ' row' + s(n);
    }
    if (rv.summary) return rv.summary.header;
    return rv.intervalReadOnly ? 'Speaker grouping unavailable' : rv.segments + ' segments · ' + rv.voices.length + ' voices';
  }
  function parseContent(o) {
    if (!o || typeof o.sessionId !== 'string') return null;
    var sumText = str(o.clipboardSummary), fullText = str(o.clipboardFull);
    var sections = [['Summary', str(o.summary)], ['Topics', str(o.topics)], ['Decisions', str(o.decisions)], ['Action items', str(o.actions)]]
      .concat((Array.isArray(o.extras) ? o.extras : []).filter(function (e) { return e && typeof e.heading === 'string' && typeof e.body === 'string'; })
        .map(function (e) { return [e.heading, e.body]; }))
      .filter(function (x) { return x[1].trim(); });
    return {
      scribeAvailable: o.scribeAvailable === true, sections: sections, clipboardSummary: sumText, clipboardFull: fullText,
      summaryChars: int(o.summaryChars) != null ? int(o.summaryChars) : sumText.length,
      fullChars: int(o.fullChars) != null ? int(o.fullChars) : fullText.length,
      removed: (Array.isArray(o.removedNames) ? o.removedNames : []).filter(function (r) { return r && str(r.label); })
        .map(function (r) { return { label: r.label, proseStale: r.proseStale === true }; }),
      recordId: str(o.recordId), sourceRevision: str(o.sourceRevision)
    };
  }
  // Markdown markers softened for reading; the clipboard keeps the real markup (MeetingContent.panelText).
  function panelText(body) {
    return String(body).split('\n').map(function (line) {
      var l = line;
      var h = /^#{1,6}\s+/.exec(l);
      if (h) l = l.slice(h[0].length).toUpperCase();
      l = l.split('- [ ] ').join('• ').split('- [x] ').join('✓ ');
      if (l.split('**').length % 2 === 1) l = l.split('**').join('');
      return l;
    }).join('\n');
  }
  function panelPreview(raw) {
    var full = panelText(raw);
    if (full.length <= 900) return full;
    var hard = full.slice(0, 900);
    var cut = Math.max(hard.lastIndexOf(' '), hard.lastIndexOf('\n'));
    var shown = (cut > 0 ? hard.slice(0, cut) : hard).trim();
    return shown + '\n\n… ' + (full.length - shown.length) + ' more characters. Use the copy buttons above.';
  }

  // ── Mac voice assignment preview (MacVoiceAssignment) ──
  var MAC_RENAME_NOTE = 'A typed name renames text only, in this meeting. To add this voice’s audio to a voice profile, pick the person from the list.';
  var MAC_RENAME_NOT_VOICE = 'A name renames text only, in this meeting. Only an unnamed Voice N can add voice samples to a profile.';
  var MAC_TYPED_NOTE = 'Renames text only, in this meeting. No voice sample is added to any profile.';
  var MAC_UNSUPPORTED = 'This server cannot add voice samples yet; it needs COS server 6.93.0 or newer. The name will be applied to this meeting as text when you save.';
  var MAC_UNATTRIBUTED = 'Voice numbers do not identify people. When voices can be distinguished, they appear as Voice 1, Voice 2 and so on; names appear only at high confidence. Name the ones you know; this changes this meeting only.';
  var GATES = ['below_floor', 'mixed_voice', 'too_little_audio'];
  function parseAssignment(o) {
    if (!o || typeof o !== 'object' || !str(o.person)) return null;
    var below = o.belowFloor === true;
    var gates = (Array.isArray(o.gates) ? o.gates : []).filter(function (g) { return typeof g === 'string' && g; });
    if (below && gates.indexOf('below_floor') < 0) gates.unshift('below_floor');
    var a = {
      person: o.person, samples: Math.max(0, int(o.enrolled) || 0), attempted: Math.max(0, int(o.attempted) || 0),
      clusterSkipped: Math.max(0, int(o.clusterSkipped) || 0), groupSec: Math.max(0, num(o.groupSec) || 0),
      similarity: num(o.similarity), belowFloor: below, floor: num(o.floor) != null ? num(o.floor) : 0.55, gates: gates,
      skipped: str(o.skipped) || null
    };
    a.canAdd = !a.skipped && a.samples > 0;
    a.needsForce = a.canAdd && a.gates.length > 0;
    return a;
  }
  function assignReason(code) {
    switch (code) {
      case 'audio_not_retained': return 'the audio for this recording is no longer kept';
      case 'no_usable_audio': return 'no clean stretch of this voice on its own was found';
      case 'store_unavailable': return 'the voice model is not available';
      case 'disabled': return 'voice samples are switched off on this server';
      case 'no_index_mapping': return 'this recording has no audio index';
      case 'owner_profile': return 'that is the wearer’s own profile, and a Mac recording has no wearer microphone';
      case 'profile_full': return 'that profile is full of other samples and has none from a Mac recording to replace';
      case 'no_stored_voice': return 'that profile has no stored voice to compare with';
      case 'deadline': return 'reading the audio took longer than the time limit. Try again and it continues where it stopped';
      default: return code ? 'the server could not use this audio (' + code + ')' : 'the server could not use this audio';
    }
  }
  function assignLines(a, voice) {
    if (!a.canAdd) return ['No voice samples will be added to ' + a.person + ': ' + assignReason(a.skipped) + '. The name will be applied to this meeting as text when you save.'];
    var out = ['Adds up to ' + a.samples + ' voice sample' + s(a.samples) + ' of ' + voice + ' to ' + a.person + '’s profile. Nothing is added until you save.'];
    if (a.attempted > 0) {
      out.push(a.clusterSkipped > 0 ? a.clusterSkipped + ' of ' + a.attempted + ' stretches of audio sounded like a different voice and were left out.'
        : a.attempted + ' stretch' + (a.attempted === 1 ? '' : 'es') + ' of audio read, none left out as a different voice.');
    }
    if (a.similarity != null) {
      out.push(a.belowFloor ? 'This voice sounds unlike ' + a.person + '’s stored profile (similarity ' + two(a.similarity) + ', usual match floor ' + two(a.floor) + ').'
        : 'Similarity to ' + a.person + '’s stored profile: ' + two(a.similarity) + '.');
    }
    if (a.gates.indexOf('mixed_voice') >= 0) out.push('This ' + voice + ' holds more than one voice, so the main one may not be ' + a.person + '.');
    if (a.gates.indexOf('too_little_audio') >= 0) out.push('Only ' + a.groupSec.toFixed(1) + ' seconds of clean audio from this voice.');
    return out;
  }
  function skipNote(code) {
    if (code === 'mac_capture') return ' · text only, no voice sample added';
    if (code === 'store_unavailable') return ' · the name is applied, but the voice samples could not be saved';
    return code ? ' · profile not updated (' + code + ')' : '';
  }

  // ── review: load ───────────────────────────────────────
  var reviewGen = 0;
  function newReview(sid, parent) {
    return {
      sid: sid, parent: parent || null, gen: ++reviewGen, loading: true, loadError: '', review: null, content: null, contentUnavailable: null,
      chunks: {}, naming: null, typed: {}, scope: 'thisMeeting', pending: null, busy: false, error: '', anchor: null, copyNote: '',
      forceArmed: false, expanded: {}, shortOpen: false, hovered: null,
      policy: { mode: 'standard', saved: 'standard', revision: null, busy: true, error: '' },
      suggest: { probed: false, routeAbsent: false, job: null, note: null, timer: null, running: false },
      groupPlan: null, groupProgress: '', groupOutcome: '', voiceNamed: false
    };
  }
  function closeReview() {
    var R = S.R;
    if (!R) return;
    if (R.review) recordVisit(R.review.sessionId, R.review.voices.length, R.review.unnamed);
    if (R.suggest.timer) clearTimeout(R.suggest.timer);
    stopPlayback(); A.note = null;
    S.R = null;
  }
  function live(R) { return S.R === R; }
  function openReview(sid, parent) {
    if (S.R && S.R.sid === sid && S.R.parent === (parent || null)) return;
    closeReview();
    if (isPhoneCapture(sid)) { W.toast(PHONE_NOTE); }
    markOpened(sid);
    var R = S.R = newReview(sid, parent);
    fetchReview(R, true);
  }
  function fetchReview(R, first) {
    R.loading = true; R.copyNote = ''; R.contentUnavailable = null;
    render();
    return call('GET', sidPath(R.sid) + '/speakers').then(function (r) {
      if (!live(R)) return;
      if (r.status !== 200 || !r.body) throw new Error(serverMessage(r.body, r.status));
      var rv = parseReview(r.body);
      if (!rv) throw new Error('The server returned a review this build cannot read.');
      if (rv.sessionId !== R.sid) throw new Error('This review does not match the selected meeting. Reopen the saved meeting.');
      R.review = rv; R.loadError = '';
      W.setCrumb(rv.title);
      if (first) { loadPolicy(R); probeSuggestions(R); }
      return (S.profiles ? Promise.resolve() : loadProfiles()).then(function () {
        if (!live(R)) return;
        return call('GET', sidPath(R.sid) + '/audio').then(function (a) {
          var map = {};
          if (a.status === 200 && a.body && Array.isArray(a.body.chunks)) a.body.chunks.forEach(function (c) { var n = int(c); if (n != null) map[n] = true; });
          R.chunks = map;
        }, function () { R.chunks = {}; });
      }).then(function () {
        if (!live(R)) return;
        return call('GET', sidPath(R.sid) + '/content').then(function (c) {
          if (c.status === 404) { R.content = null; R.contentUnavailable = 'route_absent'; return; }
          if (c.status !== 200 || !c.body) { R.content = null; R.contentUnavailable = 'error'; return; }
          var parsed = parseContent(c.body);
          if (parsed && rv.sourceRevision && parsed.sourceRevision && parsed.sourceRevision !== rv.sourceRevision) {
            R.content = null; R.contentUnavailable = 'Meeting changed while opening. Reopen review.'; return;
          }
          R.content = parsed; R.contentUnavailable = parsed ? null : 'error';
        }, function () { R.content = null; R.contentUnavailable = 'error'; });
      });
    }).catch(function (err) {
      if (!live(R)) return;
      if (R.review) R.error = err.message; else R.loadError = err.message;
    }).then(function () { if (live(R)) { R.loading = false; render(); } });
  }
  function retryReview() { var R = S.R; if (!R) return; R.error = ''; R.loadError = ''; fetchReview(R, !R.review); }

  // Voice identity policy (MeetingSpeakerPolicyView): the server owns this per-capture setting.
  function loadPolicy(R) {
    var p = R.policy;
    p.busy = true; p.revision = null; p.error = '';
    call('GET', sidPath(R.sid) + '/speaker-policy').then(function (r) {
      if (!live(R)) return;
      var b = r.body || {};
      if (r.status !== 200 || ['standard', 'high-confidence', 'anonymous'].indexOf(b.mode) < 0 || typeof b.revision !== 'string') {
        throw new Error(r.status === 200 ? 'Speaker matching mode' : serverMessage(b, r.status));
      }
      p.mode = b.mode; p.saved = b.mode; p.revision = b.revision;
      if (b.revision === 'unreadable') p.error = 'Anonymous safe mode is active because these voice settings could not be read. ' + str(b.error) + ' Choose a mode and click Repair settings to save it deliberately.';
    }).catch(function (err) { if (live(R)) p.error = 'Voice settings unavailable: ' + err.message; })
      .then(function () { if (live(R)) { p.busy = false; render(); } });
  }
  function savePolicy(R) {
    var p = R.policy, rv = R.review;
    if (p.busy || !p.revision) return;
    var selected = p.mode;
    p.busy = true; p.error = ''; render();
    var body = { mode: selected, expectedPolicyRevision: p.revision };
    if (rv && rv.recordId) body.recordId = rv.recordId;
    if (rv && rv.sourceRevision) body.expectedRevision = rv.sourceRevision;
    call('POST', sidPath(R.sid) + '/speaker-policy', body).then(function (r) {
      if (!live(R)) return;
      var b = r.body || {};
      if (r.status !== 200 || b.mode !== selected || typeof b.revision !== 'string') throw new Error(serverMessage(b, r.status));
      p.saved = selected; p.revision = b.revision;
    }).catch(function (err) { if (live(R)) p.error = err.message; })
      .then(function () { if (live(R)) { p.busy = false; render(); } });
  }

  // Suggest names (0.5.357): saved Mac calls only. A 404 hides the button silently.
  var SUG = {
    only: 'Suggestions only. Nothing is named until you click Use this name.',
    none: 'No suggestions for this call. Nothing changed.', checking: 'Checking voices',
    stopped: 'This meeting or a voice profile changed, so the voice check stopped. Suggest names again to redo it.',
    stale: 'This meeting changed, so those suggestions were dropped. Suggest names again to refresh them.',
    didNotFinish: 'The voice check did not finish. Try again.', didNotRun: 'The voice check did not run. Try again later.',
    still: 'Still checking voices. Click Suggest names, or reopen this meeting, to see where it got to.'
  };
  function parseJob(o) {
    if (!o || ['idle', 'running', 'done', 'refused', 'failed'].indexOf(o.state) < 0) return null;
    var pr = o.progress || {}, done = int(pr.done), total = int(pr.total);
    var job = { state: o.state, reason: str(o.reason) || null, done: done != null && total != null && done >= 0 && total >= done ? done : null,
      total: done != null && total != null && done >= 0 && total >= done ? total : null,
      sourceRevision: validHash(o.sourceRevision) ? o.sourceRevision : null, suggestions: [] };
    if (o.state === 'done' && o.modelSpace === '192d' && o.rule && typeof o.rule === 'object') {
      job.suggestions = (Array.isArray(o.suggestions) ? o.suggestions : []).map(function (x) {
        if (!x || x.requiresConfirmation !== true || !Array.isArray(x.labels) || !x.labels.length) return null;
        var labels = x.labels.filter(function (l) { return typeof l === 'string'; });
        var name = str(x.name), score = num(x.score);
        if (labels.length !== x.labels.length || !labels.every(isVoiceLabel) || name !== name.trim() || name.length < 2 || name.length > 200
          || isVoiceLabel(name) || score == null || score < 0 || score > 1) return null;
        return { labels: labels, name: name, score: score, id: name + '|' + labels.join('|') };
      }).filter(Boolean);
    }
    return job;
  }
  function applyJob(R, r) {
    var g = R.suggest, prev = g.job;
    g.probed = true; g.note = null;
    if (r.status === 404) { g.routeAbsent = true; g.job = null; return; }
    var job = r.body ? parseJob(r.body) : null;
    if (!job) { g.routeAbsent = false; g.job = null; g.note = SUG.didNotFinish; return; }
    g.routeAbsent = false;
    if (job.state === 'idle' && prev && prev.state === 'done' && prev.sourceRevision !== job.sourceRevision) return;
    if (job.state === 'idle' && prev && prev.state === 'running') g.note = SUG.stopped;
    g.job = job;
  }
  function pollSuggestions(R, first, attempt, failures) {
    var g = R.suggest;
    if (!live(R)) return;
    if (attempt >= 1200) { g.note = SUG.still; g.job = null; g.running = false; render(); return; }
    call(first ? 'POST' : 'GET', sidPath(R.sid) + '/voice-suggestions', first ? {} : undefined).then(function (r) {
      if (!live(R)) return;
      applyJob(R, r);
      render();
      if (g.job && g.job.state === 'running') g.timer = setTimeout(function () { pollSuggestions(R, false, attempt + 1, 0); }, 1500);
      else g.running = false;
    }, function () {
      if (!live(R)) return;
      if (failures + 1 < 3) { g.timer = setTimeout(function () { pollSuggestions(R, false, attempt + 1, failures + 1); }, 1500); return; }
      if (g.probed) { g.note = SUG.didNotFinish; g.job = null; }
      g.running = false; render();
    });
  }
  function probeSuggestions(R) { if (R.review && R.review.canSuggest) { R.suggest.running = true; pollSuggestions(R, false, 0, 0); } }
  function startSuggestions() {
    var R = S.R;
    if (!R || R.busy || !R.review || !showsSuggest(R) || isRunning(R)) return;
    if (R.suggest.timer) clearTimeout(R.suggest.timer);
    R.suggest.note = null; R.suggest.job = null; R.suggest.running = true;
    render();
    pollSuggestions(R, true, 0, 0);
  }
  function showsSuggest(R) { return !!(R.review && R.review.canSuggest && R.suggest.probed && !R.suggest.routeAbsent); }
  function isRunning(R) { return !!(R.suggest.job && R.suggest.job.state === 'running'); }
  function suggestLine(R) {
    if (!showsSuggest(R)) return null;
    var g = R.suggest, job = g.job;
    if (g.note) return g.note;
    if (!job || job.state === 'idle') return SUG.only;
    if (job.state === 'running') return job.done != null ? (job.total > 0 ? SUG.checking + ', ' + job.done + ' of ' + job.total : SUG.checking) : SUG.checking;
    if (job.state === 'refused') return refusalText(job.reason);
    if (job.state === 'failed') return failureText(job.reason);
    if (!job.sourceRevision || job.sourceRevision !== R.review.sourceRevision) return SUG.stale;
    return job.suggestions.length ? job.suggestions.length + ' suggestion' + s(job.suggestions.length) + '. ' + SUG.only : SUG.none;
  }
  function refusalText(reason) {
    var map = {
      recording_active: 'A recording is active. Try again when it ends.', meeting_finalizing: FINALIZING,
      maintenance: 'COS is updating or restarting. Try again in a minute.', job_running_elsewhere: 'Another call’s voice check is running. Try again when it ends.',
      speaker_model_unavailable: 'The voice model is not available on this Mac right now.',
      audio_not_retained: 'This call’s audio is no longer kept, so its voices cannot be checked.',
      not_enough_voice_profiles: 'There are not enough saved voice profiles to compare with.',
      profile_store_unreadable: 'The saved voice profiles could not be read. Try again later.',
      no_index_mapping: 'This recording has no map to find its audio, so its voices cannot be checked.',
      derived_call_view: 'This call has a grouped view, so its voices cannot be checked here.',
      not_saved_mac_capture: 'Suggestions work on saved Mac calls only.', sidecar_unreadable: 'This call’s saved speaker data could not be read.'
    };
    if (!reason) return SUG.didNotRun;
    return map[reason] || (reason.indexOf(' ') >= 0 ? reason : SUG.didNotRun);
  }
  function failureText(reason) {
    var map = {
      recording_active: 'A recording started, so the voice check stopped. Try again when it ends.',
      maintenance: 'COS was updating or restarting, so the voice check stopped. Try again.',
      meeting_finalizing: 'This meeting is being saved, so the voice check stopped. Try again in a minute.',
      deadline: 'The voice check ran out of time. Try again.', profile_store_unreadable: 'The saved voice profiles could not be read. Try again later.'
    };
    return map[reason] || SUG.didNotFinish;
  }
  // Every suggestion a row holds, widest first; a Mac voice is never offered the wearer's own profile.
  function suggestionsFor(R, labels) {
    var rv = R.review, job = R.suggest.job;
    if (!rv || !job || job.state !== 'done' || !job.sourceRevision || job.sourceRevision !== rv.sourceRevision) return [];
    var owners = (S.profiles || []).filter(function (p) { return p.isOwner; }).map(function (p) { return p.name; });
    return job.suggestions.map(function (x, i) { return { x: x, i: i }; }).filter(function (o) {
      return o.x.labels.every(function (l) { return labels.indexOf(l) >= 0 && rv.byLabel[l] && canNameAlone(rv, rv.byLabel[l]); })
        && owners.indexOf(o.x.name) < 0;
    }).sort(function (a, b) { return a.x.labels.length !== b.x.labels.length ? b.x.labels.length - a.x.labels.length : a.i - b.i; })
      .map(function (o) { return o.x; });
  }

  // ── review: corrections (two steps, ControllerModel 10657-10969) ──
  // Classify a per-meeting correction answer the way the helper does (emitMeetingCorrection).
  function classify(r, confirmed) {
    var b = r.body;
    var unknownProfile = r.status === 404 && b && b.reason === 'unknown_profile';
    if (r.status === 404 && !unknownProfile) return { state: 'route_missing', httpStatus: 404, result: {} };
    if (!b) throw new Error('Server stopped');
    var notApplicable = r.status === 400 && ['not_a_voice_label', 'not_mac_capture'].indexOf(str(b.reason)) >= 0;
    var gated = r.status === 400 && !notApplicable;
    var pending = r.status === 409;
    var declined = r.status === 422 || unknownProfile || notApplicable;
    if (r.status !== 200 && !gated && !pending && !declined) throw new Error(serverMessage(b, r.status));
    var state;
    if (pending) {
      state = { correction_pending: 'pending_correction', meeting_finalizing: 'meeting_finalizing', record_source_mismatch: 'record_source_mismatch',
        direct_library_read_only: 'direct_library_read_only' }[str(b.reason)] || 'declined';
    } else if (declined) state = 'declined';
    else if (confirmed && r.status === 200) state = 'applied';
    else state = 'preview';
    return { state: state, httpStatus: r.status, result: b, reason: str(b.reason) || null, message: str(b.message) || str(b.error) || 'Preview ready' };
  }
  // The global fold: 409 is the server refusing a below-floor merge, 400 its confirmation gate; both carry the report.
  function classifyMerge(r, confirmed) {
    var b = r.body;
    if (!b) throw new Error('Server stopped');
    var refused = r.status === 409, gated = r.status === 400;
    if (r.status !== 200 && !refused && !gated) throw new Error(serverMessage(b, r.status));
    var report = (b.report && typeof b.report === 'object') ? b.report : (b.preview && typeof b.preview === 'object') ? b.preview : b;
    // The helper's own line is the fallback the card shows when the report carries no sentence.
    return { state: refused ? 'refused' : (gated ? 'preview' : (confirmed ? 'merged' : 'preview')), httpStatus: r.status, result: report,
      isMerge: true, message: refused ? 'Merge refused: voices too far apart' : (confirmed ? 'Profiles merged' : '') };
  }
  function buildCorrection(from, to, scope, cls, opts) {
    var o = opts || {};
    var state = cls.state, result = cls.result || {};
    var refused = ['refused', 'declined', 'meeting_finalizing', 'record_source_mismatch', 'direct_library_read_only'].indexOf(state) >= 0;
    var pendingEarlier = state === 'pending_correction';
    var training = result.training && typeof result.training === 'object' ? result.training : {};
    // The global fold is the one irreversible voice write: its preview always states that, never a neutral server line.
    var serverMsg = cls.isMerge && !refused ? '' : withoutForce(str(result.message) || str(result.error) || cls.message || '', '');
    var message;
    if (state === 'meeting_finalizing') message = FINALIZING;
    else if (state === 'record_source_mismatch') message = 'This meeting changed since you opened it. Reopen it, then try again.';
    else if (state === 'direct_library_read_only') message = 'This meeting comes from a read-only library, so its speakers cannot be corrected here.';
    else if (pendingEarlier) message = EARLIER;
    else if (refused) message = serverMsg || 'The server declined this, so nothing was applied.';
    else if (serverMsg) message = serverMsg;
    else if (to == null) message = 'Removes ' + from + ' from this meeting.';
    else message = scope === 'thisMeeting' ? 'Renames ' + from + ' to ' + to + ' in this meeting only.'
      : 'Folds ' + from + ' into ' + to + ' across every meeting. This cannot be undone here.';
    var surf = result.surfaces && typeof result.surfaces === 'object' ? result.surfaces : {};
    var sim = result.similarity && typeof result.similarity === 'object' ? num(result.similarity[from]) : null;
    var assignment = o.assign && !(refused || pendingEarlier) ? parseAssignment(result.enrolment) : null;
    return {
      from: from, to: to, scope: scope, message: message,
      surfaces: { sidecar: int(surf.sidecar) || 0, attendees: int(surf.attendees) || 0, transcript: int(surf.transcript) || 0 },
      similarity: sim, refused: refused || pendingEarlier, forceable: pendingEarlier, proseStale: result.proseStale === true,
      isNameAssignment: !!o.isNameAssignment, createsProfile: !!o.createsProfile,
      wouldRetract: int(training.wouldRetract) || 0, untraceable: int(training.untraceable) || 0,
      assignment: assignment, assignUnsupported: !!o.assign && !(refused || pendingEarlier) && !assignment
    };
  }
  function addsSamples(c) { return !!(c.assignment && c.assignment.canAdd); }
  function needsForce(c) { return !!(c.assignment && c.assignment.needsForce); }
  // Which assignment flags a confirm sends; null means a flagged plan that must not be sent by a plain Save.
  function assignFlags(c, renameOnly, addAnyway, armed) {
    if (!addsSamples(c) || renameOnly) return {};
    if (needsForce(c)) return addAnyway && armed ? { assignVoiceProfile: true, force: true } : null;
    return { assignVoiceProfile: true };
  }
  function guardWrite(R) {
    var rv = R && R.review;
    if (!rv || !rv.mutable) { if (R) R.error = READ_ONLY; render(); return false; }
    if (isPhoneCapture(rv.sessionId)) { R.error = PHONE_NOTE; render(); return false; }
    return true;
  }
  function withRevision(rv, body) {
    if (rv.recordId) body.recordId = rv.recordId;
    if (rv.sourceRevision) body.expectedRevision = rv.sourceRevision;
    return body;
  }
  function previewRename(from, to, scope, isNameAssignment, assign) {
    var R = S.R;
    if (R) R.anchor = from;
    if (from === to || !guardWrite(R)) return;
    var rv = R.review;
    scope = rv.isMac ? 'thisMeeting' : scope;
    var profiles = S.profiles || [];
    var createsProfile = !rv.isMac && !profiles.some(function (p) { return p.name.toLowerCase() === to.toLowerCase(); });
    var assigned = assign && rv.isMac && isVoiceLabel(from) ? (profiles.filter(function (p) { return p.name === to && !p.isOwner; })[0] || {}).name : null;
    R.forceArmed = false; R.groupPlan = null; R.busy = true; R.anchor = from;
    render();
    var req = scope === 'thisMeeting'
      ? call('POST', sidPath(R.sid) + '/relabel', withRevision(rv, assigned ? { from: from, to: to, assignVoiceProfile: true, dryRun: true } : { from: from, to: to, dryRun: true })).then(function (r) { return classify(r, false); })
      : call('POST', '/api/voice/merge-profiles', { into: to, from: from, dryRun: true }).then(function (r) { return classifyMerge(r, false); });
    req.then(function (cls) {
      if (!live(R)) return;
      R.pending = buildCorrection(from, to, scope, cls, { isNameAssignment: isNameAssignment, createsProfile: createsProfile, assign: !!assigned });
      R.naming = null; R.error = '';
    }, function (err) {
      if (!live(R)) return;
      R.error = 'Could not check that name: ' + err.message; R.pending = null;
    }).then(function () { if (live(R)) { R.busy = false; render(); } });
  }
  function previewDeattribution(from) {
    var R = S.R;
    if (R) R.anchor = from;
    if (!guardWrite(R)) return;
    var rv = R.review;
    R.busy = true; R.anchor = from; render();
    call('POST', sidPath(R.sid) + '/deattribute', withRevision(rv, { from: from, dryRun: true })).then(function (r) {
      if (!live(R)) return;
      R.pending = buildCorrection(from, null, 'thisMeeting', classify(r, false), {});
      R.naming = null; R.error = '';
    }).catch(function (err) {
      if (!live(R)) return;
      R.error = 'Could not check that: ' + err.message; R.pending = null;
    }).then(function () { if (live(R)) { R.busy = false; render(); } });
  }
  // Vouch for a label the display floor withheld. It rewrites nothing, so there is no preview step.
  function confirmVoice(label) {
    var R = S.R;
    if (R) R.anchor = label;
    if (!guardWrite(R)) return;
    var rv = R.review;
    R.busy = true; R.anchor = label; render();
    call('POST', sidPath(R.sid) + '/confirm', withRevision(rv, { label: label })).then(function (r) {
      if (r.status !== 200 || !r.body) throw new Error(serverMessage(r.body, r.status));
      if (!live(R)) return;
      R.error = ''; S.dir = null;
      return fetchReview(R, false);
    }).catch(function (err) { if (live(R)) R.error = 'Could not confirm that name: ' + err.message; })
      .then(function () { if (live(R)) { R.busy = false; render(); } });
  }
  function confirmCorrection(c, o) {
    var R = S.R, opt = o || {};
    if (c.refused && !opt.force) { R.pending = null; render(); return; }
    var flags = assignFlags(c, !!opt.renameOnly, !!opt.addAnyway, R.forceArmed);
    if (!flags) return;
    if (!guardWrite(R)) return;
    var rv = R.review, path, body, merge = false;
    if (c.to == null) { path = sidPath(R.sid) + '/deattribute'; body = withRevision(rv, { from: c.from, confirm: true }); }
    else if (c.scope === 'thisMeeting') {
      path = sidPath(R.sid) + '/relabel';
      body = withRevision(rv, { from: c.from, to: c.to, confirm: true });
      if (flags.assignVoiceProfile) body.assignVoiceProfile = true;
      if (flags.force) body.force = true;
    } else { merge = true; path = '/api/voice/merge-profiles'; body = { into: c.to, from: c.from, confirm: true }; }
    // "Apply anyway" passes force only for a stalled earlier correction; a merge refusal is never forced from here.
    if (opt.force && !merge) body.force = true;
    R.busy = true; render();
    call('POST', path, body).then(function (r) {
      if (!live(R)) return;
      var cls = merge ? classifyMerge(r, true) : classify(r, true);
      var applied = cls.state === 'applied' || (merge && cls.state === 'merged');
      if (!applied) {
        var result = cls.result || {};
        var detail = withoutForce(str(result.message) || str(result.error) || cls.message || '', '') || null;
        var fresh = GATES.indexOf(str(result.reason)) >= 0 ? parseAssignment(result.enrolment) : null;
        if (fresh) { c.assignment = fresh; c.assignUnsupported = false; R.forceArmed = false; R.error = detail || ''; return; }
        if (cls.state === 'route_missing') R.error = 'This needs COS server 6.21.18 or newer. Use Update Server.';
        else if (cls.state === 'pending_correction') R.error = EARLIER;
        else if (cls.state === 'meeting_finalizing') R.error = FINALIZING;
        else R.error = detail || 'The server did not apply that (' + cls.state + ').';
        return;   // the card stays so the person can retry or cancel deliberately
      }
      var en = (cls.result && cls.result.enrolment) || {};
      var created = en.created === true, enrolled = int(en.enrolled) || 0;
      var notice;
      if (created && c.to) notice = c.to + ' added to voice profiles (' + enrolled + ' sample' + s(enrolled) + ')';
      else if (enrolled > 0 && c.to) notice = c.from + ' is now ' + c.to + ' in this meeting · ' + enrolled + ' samples added';
      else if (c.to == null) notice = 'Removed ' + c.from + ' from this meeting';
      else if (c.scope === 'thisMeeting') notice = c.from + ' is now ' + c.to + ' in this meeting' + skipNote(str(en.skipped));
      else notice = 'Saved. ' + c.from + ' is now ' + c.to + ' everywhere';
      W.toast(notice);
      R.pending = null; R.scope = 'thisMeeting'; R.error = ''; R.voiceNamed = true; S.dir = null;
      return loadProfiles().then(function () { if (live(R)) return fetchReview(R, false); });
    }).catch(function (err) {
      if (!live(R)) return;
      R.error = err.message; R.pending = null;
    }).then(function () { if (live(R)) { R.busy = false; render(); } });
  }
  function groupStepRefusal(cls) {
    var detail = withoutForce(str(cls.result && (cls.result.message || cls.result.error)) || cls.message || '', '');
    if (cls.state === 'route_missing') return 'This needs a newer COS server. Use Update Server.';
    if (cls.state === 'pending_correction') return EARLIER;
    if (cls.state === 'meeting_finalizing') return FINALIZING;
    return detail || 'The server did not apply that (' + cls.state + ').';
  }
  function labelList(labels) {
    var all = labels.every(isVoiceLabel);
    var shown = all ? labels.map(function (l) { return l.slice(6); }) : labels;
    if (!shown.length) return 'no labels';
    return (all ? 'Voice ' : '') + (shown.length === 1 ? shown[0] : shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1]);
  }
  function groupOutcomeLine(o) {
    var named = o.labels.slice(0, o.namedCount), notNamed = o.labels.slice(o.namedCount);
    var sentence;
    if (!o.reason) sentence = 'Named ' + labelList(named) + ' ' + o.to + ' in this meeting.';
    else {
      var why = o.stoppedAt ? 'Stopped at ' + o.stoppedAt + ': ' + o.reason : o.reason;
      sentence = !named.length ? 'Nothing was named. ' + why : 'Named ' + labelList(named) + ' ' + o.to + '. Not named: ' + labelList(notNamed) + '. ' + why;
    }
    var seen = {};
    return sentence + (o.skipped || []).filter(function (k) { if (seen[k]) return false; seen[k] = true; return true; }).map(skipNote).join('');
  }
  // Naming a merged row: one dryRun per label at one revision, nothing written until Save.
  // `anchor` is where the plan card, progress and any refusal draw: the merged row's id, or null for the top of the list.
  function previewGroupName(row, rawName, assign, anchor) {
    var R = S.R, rv = R && R.review;
    var name = String(rawName || '').trim();
    var at = anchor === undefined ? row.id : anchor;
    if (!rv || R.busy || name.length < 2 || !row.members.every(function (v) { return canNameAlone(rv, v); })) {
      if (R) { R.anchor = at; R.error = 'This voice group changed. Reopen the meeting before naming it.'; render(); }
      return;
    }
    if (isPhoneCapture(rv.sessionId)) { R.anchor = at; R.error = PHONE_NOTE; render(); return; }
    var assigned = assign && (S.profiles || []).some(function (p) { return p.name === name && !p.isOwner; });
    var labels = row.members.map(function (v) { return v.label; });
    R.busy = true; R.pending = null; R.groupPlan = null; R.groupOutcome = ''; R.anchor = at;
    var corrections = [], i = 0;
    function step() {
      if (!live(R)) return Promise.resolve();
      if (i >= row.members.length) return Promise.resolve(true);
      var v = row.members[i];
      R.groupProgress = 'Checking ' + v.label + ', ' + (i + 1) + ' of ' + labels.length; render();
      var body = withRevision(rv, { from: v.label, to: name, dryRun: true });
      if (assigned) body.assignVoiceProfile = true;
      return call('POST', sidPath(R.sid) + '/relabel', body).then(function (r) {
        if (!live(R)) return;
        var cls = classify(r, false);
        var c = buildCorrection(v.label, name, 'thisMeeting', cls, { isNameAssignment: v.isNameAssignment, assign: assigned });
        if (c.refused || cls.state !== 'preview') {
          R.groupOutcome = groupOutcomeLine({ to: name, labels: labels, namedCount: 0, stoppedAt: v.label, reason: c.refused ? c.message : groupStepRefusal(cls) });
          return false;
        }
        corrections.push(c); i++;
        return step();
      }, function (err) {
        if (!live(R)) return;
        R.groupOutcome = groupOutcomeLine({ to: name, labels: labels, namedCount: 0, stoppedAt: v.label, reason: err.message });
        return false;
      });
    }
    render();
    step().then(function (ok) {
      if (!live(R) || !ok) return;
      R.naming = null; R.error = '';
      R.groupPlan = { rowId: row.id, revision: rv.sourceRevision, to: name, corrections: corrections, labels: labels };
    }).then(function () { if (live(R)) { R.busy = false; R.groupProgress = ''; render(); } });
  }
  // Save a previewed group one label at a time; each write moves the revision, so the review is read between writes.
  function confirmGroupName(plan) {
    var R = S.R, rv = R && R.review;
    if (!rv || R.busy || !R.groupPlan || R.groupPlan.rowId !== plan.rowId || !rv.mutable || rv.sourceRevision !== plan.revision) {
      if (R) { R.groupPlan = null; R.error = 'This voice group changed. Reopen the meeting before saving a name.'; render(); }
      return;
    }
    R.busy = true; R.groupPlan = null; R.groupOutcome = '';
    var named = 0, samples = 0, stop = null, skips = [], review = rv, i = 0;
    function step() {
      if (i >= plan.corrections.length) return Promise.resolve();
      var c = plan.corrections[i];
      if (!review.byLabel[c.from] || !review.byLabel[c.from].canRename) { stop = 'It is no longer in this meeting.'; return Promise.resolve(); }
      R.groupProgress = 'Naming ' + c.from + ', ' + (i + 1) + ' of ' + plan.labels.length; render();
      var body = withRevision(review, { from: c.from, to: plan.to, confirm: true });
      var f = assignFlags(c, needsForce(c), false, false) || {};
      if (f.assignVoiceProfile) body.assignVoiceProfile = true;
      return call('POST', sidPath(R.sid) + '/relabel', body).then(function (r) {
        var cls = classify(r, true);
        if (cls.state !== 'applied') { stop = groupStepRefusal(cls); return; }
        named++;
        var en = (cls.result && cls.result.enrolment) || {};
        samples += int(en.enrolled) || 0;
        if (str(en.skipped)) skips.push(en.skipped);
        i++;
        if (i >= plan.corrections.length) return;
        if (!live(R)) { stop = 'Another meeting was opened, so the rest were left.'; return; }
        return call('GET', sidPath(R.sid) + '/speakers').then(function (g) {
          var next = g.status === 200 ? parseReview(g.body) : null;
          if (!next || next.sessionId !== R.sid || !next.mutable) { stop = 'The meeting could not be read again after that name.'; return; }
          review = next; R.review = next;
          return step();
        });
      }).catch(function (err) { stop = err.message; });
    }
    render();
    step().then(function () {
      var line = groupOutcomeLine({ to: plan.to, labels: plan.labels, namedCount: named, stoppedAt: stop ? plan.labels[named] : null, reason: stop, skipped: skips });
      if (!live(R)) { W.toast(line); return; }
      var after = named > 0 ? loadProfiles().then(function () { S.dir = null; R.voiceNamed = true; return fetchReview(R, false); }) : Promise.resolve();
      return after.then(function () {
        if (!stop) W.toast(line + (samples > 0 ? ' ' + samples + ' voice sample' + s(samples) + ' added.' : ''));
        else R.groupOutcome = line;
      });
    }).then(function () { if (live(R)) { R.busy = false; R.groupProgress = ''; render(); } });
  }
  function useSuggestion(sg, rowLabels) {
    var R = S.R, rv = R && R.review;
    if (!rv || !suggestionsFor(R, rowLabels).some(function (x) { return x.id === sg.id; })) return;
    var members = sg.labels.map(function (l) { return rv.byLabel[l]; }).filter(Boolean);
    if (members.length !== sg.labels.length || !members.length) return;
    if (members.length === 1) previewRename(members[0].label, sg.name, 'thisMeeting', members[0].isNameAssignment, true);
    else {
      // The card belongs under the merged row that holds this suggestion, never under an id nothing renders.
      var holder = null;
      ((rv.layout && rv.layout.rows) || []).forEach(function (r) {
        if (r.merged && r.merged.members.map(function (v) { return v.label; }).join('|') === rowLabels.join('|')) holder = r.merged.id;
      });
      previewGroupName({ id: 'suggestion:' + sg.id, members: members, seconds: null }, sg.name, true, holder);
    }
  }

  // ── render: shell ──────────────────────────────────────
  // #/speakers shows whichever view the picker holds, so Back from any of the three leaves the section (Control's Back
  // from a section root goes home) and the phone keeps its section switcher. #/speakers/samples and /voices still open
  // as deep links: load() selects the view and rewrites the hash to #/speakers.
  function route() {
    var a = W.parseRoute().args;
    if (a[0] === 'review' && a[1]) return { view: S.view, review: a[1] };
    if (a[0] === 'voice' && a[1] && a[2] === 'review' && a[3]) return { view: 'voices', voice: a[1], review: a[3] };
    if (a[0] === 'voice' && a[1]) return { view: 'voices', voice: a[1] };
    return { view: S.view };
  }
  function viewOf(id) { return VIEWS.filter(function (v) { return v.id === id; })[0] || VIEWS[0]; }
  function heroDetail(view) {
    if (view === 'samples') return samplesDetail();
    if (view === 'meetings') {
      var list = S.meetings || [];
      if (!list.length) return 'Choose a saved meeting to name its voices.';
      var parts = [list.length + ' recent saved meetings'];
      var unnamed = list.filter(function (m) { var t = voiceTag(m); return t && t.kind === 'needs'; }).length;
      var done = list.filter(function (m) { var t = voiceTag(m); return t && t.kind === 'reviewed'; }).length;
      var fresh = list.filter(function (m) { return isNew(m.sessionId); }).length;
      if (unnamed > 0) parts.push(unnamed + ' still need names');
      if (done > 0) parts.push(done + ' reviewed');
      if (fresh > 0) parts.push(fresh + ' new');
      return parts.join(' · ');
    }
    var dir = S.dir || [];
    if (!dir.length) return 'Enrolled identities and cross-meeting evidence.';
    if (S.dirRoute === false) return dir.length + ' enrolled profiles · history unavailable on this server';
    var review = dir.reduce(function (t, p) { return t + p.reviewMeetingCount; }, 0);
    var samples = dir.reduce(function (t, p) { return t + p.embeddings; }, 0);
    return fmt(dir.length) + ' enrolled · ' + fmt(samples) + ' sample' + s(samples) + ' · ' + fmt(review) + ' review occurrence' + s(review);
  }
  function hero(view) {
    var loading = view === 'meetings' ? S.meetingsLoading : view === 'samples' ? !!(S.H && S.H.loading) : S.dirLoading;
    var title = view === 'meetings' ? refreshTitle() : 'Refresh';
    var prominent = view === 'meetings' && S.refreshNeeded;
    return '<header class="cx-hero" data-tint="speakers"><span class="cx-glyph">' + icon('speakers') + '</span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">' + esc(viewOf(view).hero) + '</h1><p class="cx-detail-line">' + esc(heroDetail(view)) + '</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn ' + (prominent ? 'primary' : 'quiet') + '" data-sp="refresh"' + (loading ? ' disabled' : '') + '>' +
      icon('refresh') + esc(title) + '</button></div></header>';
  }
  function select(id, label, options, value) {
    return '<label class="sp-select"><select class="field" id="' + id + '" aria-label="' + esc(label) + '">' +
      options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') +
      '</select></label>';
  }
  function toolbar(view) {
    var sw = '<div class="cx-switch" role="group" aria-label="Speaker view"><span class="cx-switch-label">Speaker view</span>' +
      VIEWS.map(function (v) { return '<button type="button" data-sp="view" data-view="' + v.id + '" aria-pressed="' + (v.id === view) + '">' + esc(v.title) + '</button>'; }).join('') + '</div>';
    var extra = '';
    if (view === 'meetings') {
      extra = '<label class="cx-check sp-check" title="Keep finished meetings off the list while you work through names."><input type="checkbox" id="sp-hide"' + (P.hideReviewed ? ' checked' : '') + '>Hide reviewed</label>' +
        select('sp-msort', 'Sort meetings', MEETING_SORTS, P.sort);
    } else if (view === 'voices') {
      extra = '<div class="cx-search sp-search"><input class="field" type="search" id="sp-vq" placeholder="Search voices" value="' + esc(S.voiceSearch) + '" autocomplete="off" aria-label="Search enrolled voices"></div>' +
        select('sp-vsort', 'Sort voices', VOICE_SORTS, S.voiceSort);
    }
    return '<div class="cx-controls sp-controls">' + sw + '<div class="sp-tools">' + extra + '</div></div>';
  }
  function emptyState(text, extra) {
    return '<div class="sp-empty"><span class="cx-glyph">' + icon('speakers') + '</span><p>' + esc(text) + '</p>' + (extra || '') + '</div>';
  }

  // ── render: Meetings to review ─────────────────────────
  function pills(m) {
    var out = '';
    if (isNew(m.sessionId)) out += '<span class="cx-pill warn">NEW</span>';
    var t = voiceTag(m);
    if (t && t.kind === 'reviewed') out += '<span class="cx-pill ok">REVIEWED</span>';
    else if (t && t.kind === 'needs') out += '<span class="cx-pill warn">' + (t.n === 1 ? '1 TO NAME' : t.n + ' TO NAME') + '</span>';
    return out;
  }
  function meetingRow(m) {
    var p = pills(m);
    return '<button type="button" class="cx-row sp-mrow" data-sp="open-review" data-sid="' + esc(m.sessionId) + '">' +
      '<span class="cx-row-glyph">' + icon('speakers') + '</span><span class="cx-row-body">' +
      '<span class="cx-row-title strong sp-one">' + esc(m.title) + '</span>' +
      '<span class="sp-mono">' + esc(dateLine(m)) + '</span>' +
      '<span class="sp-counts">' + esc(countsSummary(m)) + '</span>' +
      (p ? '<span class="sp-pills sp-pills-in">' + p + '</span>' : '') + '</span>' +
      '<span class="sp-pills sp-pills-side">' + p + '</span><span class="chev"></span></button>';
  }
  function meetingsBody() {
    if (S.meetingsLoading && !S.meetings) return '<p class="cx-note sp-loading">' + spin() + 'Loading meetings…</p>';
    if (!S.meetings) return '';
    if (!S.meetings.length) return emptyState(S.meetingsError || 'No reviewable meetings yet.');
    var rows = visibleMeetings();
    if (!rows.length) return emptyState('All recent meetings are reviewed. Turn off Hide reviewed to see them.');
    return '<div class="cx-list sp-list">' + rows.map(meetingRow).join('') + '</div>';
  }

  // ── render: Samples to review ──────────────────────────
  function samplesDetail() {
    var H = S.H;
    if (!H || H.state == null) return 'Asking the server what it is holding.';
    if (H.state === 'error') return 'Held voices could not be grouped. The card says why.';
    if (H.extLoadFailed && !heldUsable(H)) return 'Held audio could not be read. Refresh to try again.';
    if (heldUsable(H)) {
      var v = H.groups.length, l = H.loose.length;
      if (!v && !l) return 'Unrecognized voices wait here for 72 hours.';
      return fmt(v) + ' held voice' + s(v) + ' · ' + fmt(l) + ' loose sample' + s(l) + ' · kept 72 hours';
    }
    var n = H.extSessions.length;
    return n ? fmt(n) + ' unrecognized session' + s(n) + ' · kept 72 hours' : 'Unrecognized voices wait here for 72 hours.';
  }
  function heldLead(H) {
    var v = H.groups.length, l = H.loose.length, p = H.pending;
    if (!v && !l) return p > 0 ? 'Reading ' + p + ' held sample' + s(p) + '. Refresh in a moment.' : 'No unrecognized audio is being held. Record a meeting, then come back within 72 hours.';
    var parts = [];
    if (v > 0) parts.push(v + ' voice' + s(v) + ' the server is holding, grouped by who they sound like across meetings.');
    if (l > 0) {
      var sug = H.loose.filter(function (x) { return x.suggestion; }).length;
      parts.push(l + ' loose sample' + s(l) + ' to review individually' + (sug > 0 ? ', ' + sug + ' with a suggestion' : '') + '.');
    }
    if (p > 0) parts.push(p + ' still being read.');
    if (H.unusable > 0) parts.push(H.unusable + ' could not be read and will expire with the window.');
    if (!H.speakerModel) parts.push('The speaker model is not loaded on this Mac (Run checks shows it): voices can be heard and discarded, not named yet.');
    return parts.join(' ');
  }
  function notice(text) { return '<div class="sp-notice"><span class="sp-i" aria-hidden="true">i</span><span>' + esc(text) + '</span></div>'; }
  function listenStrip(key, refs, voice) {
    if (!refs.length) return '';
    var H = S.H;
    var cur = Math.min(Math.max(H.cursor[key] || 0, 0), refs.length - 1);
    var ref = refs[cur], playKey = 'held:' + ref.sessionId + '#' + ref.chunkIndex;
    var playing = A.key === playKey;
    return '<div class="sp-listen" data-key="' + esc(key) + '">' +
      '<button type="button" class="sp-play' + (playing ? ' on' : '') + '" data-sp="held-play" data-key="' + esc(key) + '" data-voice="' + esc(voice) + '" aria-label="' +
      (playing ? 'Stop' : 'Listen to sample ' + (cur + 1) + ' of ' + refs.length) + '" title="' + (playing ? 'Stop' : 'Listen to this sample') + '">' +
      (playing ? '<span class="sp-stop-glyph"></span>' : '<span class="sp-play-glyph"></span>') + '</button>' +
      '<button type="button" class="sp-step" data-sp="held-prev" data-key="' + esc(key) + '" aria-label="Previous sample"' + (refs.length < 2 ? ' disabled' : '') + '>‹</button>' +
      '<span class="sp-pos">' + (cur + 1) + ' of ' + refs.length + '</span>' +
      '<button type="button" class="sp-step" data-sp="held-next" data-key="' + esc(key) + '" aria-label="Next sample"' + (refs.length < 2 ? ' disabled' : '') + '>›</button></div>';
  }
  // The "Adds to" hint matches the server's case-folded, compatibility-normalized lookup.
  function nameHint(typed) {
    var name = String(typed || '').trim();
    if (name.length < 2) return '';
    var fold = function (x) { try { return x.normalize('NFKC').toLowerCase(); } catch (_e) { return x.toLowerCase(); } };
    var dir = S.dir || [];
    var matches = dir.filter(function (p) { return fold(p.name) === fold(name); });
    var exact = matches.length === 1 ? matches[0] : null;
    var lines = [];
    if (matches.length > 1) lines.push(esc('Several stored voices share this spelling. Resolve the duplicate names before applying.'));
    else if (exact) {
      lines.push(esc('Adds to ' + exact.name + ', who has ' + exact.embeddings + ' sample' + s(exact.embeddings) + '.'));
      if (exact.embeddings >= 40) lines.push(esc('At the 40-sample limit, the server chooses which voice samples to keep.'));
      if (exact.isOwner) lines.push(esc('This is your owner voice. Preview requires owner verification.'));
    } else {
      lines.push(esc('Creates a new voice.'));
      var near = dir.filter(function (p) { return p.name.toLowerCase().indexOf(name.toLowerCase()) >= 0; }).slice(0, 3);
      if (near.length) lines.push('<span class="sp-chips">Did you mean ' + near.map(function (p) {
        return '<button type="button" class="cx-btn quiet sp-chip" data-sp="held-fill" data-name="' + esc(p.name) + '">' + esc(p.name) + '</button>';
      }).join('') + '</span>');
    }
    return lines.map(function (l) { return '<span>' + l + '</span>'; }).join('');
  }
  function heldActions(key, count, suggestion) {
    var H = S.H;
    var disabledName = H.busy || !H.speakerModel || !H.namingAvailable;
    if (H.naming === key) {
      return '<div class="sp-held-name"><div class="sp-inline">' +
        '<input class="field sp-field" id="sp-held-input" type="text" placeholder="Who is this?" value="' + esc(H.typed) + '" autocomplete="off" aria-label="Who is this?">' +
        '<button type="button" class="cx-btn primary" data-sp="held-preview"' + (disabledName || H.typed.trim().length < 2 ? ' disabled' : '') + '>Preview</button>' +
        '<button type="button" class="sp-text" data-sp="held-cancel">Cancel</button>' + (H.busy ? spin() : '') + '</div>' +
        '<div class="sp-hint" id="sp-held-hint">' + nameHint(H.typed) + '</div></div>';
    }
    if (H.confirmDiscard === key) {
      return '<div class="sp-inline"><span class="sp-muted">Discard ' + count + ' sample' + s(count) + '?</span>' +
        '<button type="button" class="cx-btn sp-danger" data-sp="held-discard-yes" data-key="' + esc(key) + '"' + (H.busy ? ' disabled' : '') + '>Discard</button>' +
        '<button type="button" class="sp-text" data-sp="held-discard-no">Keep</button></div>';
    }
    return '<div class="sp-inline sp-held-acts">' +
      (suggestion ? '<button type="button" class="cx-btn primary" data-sp="held-add" data-key="' + esc(key) + '"' + (disabledName ? ' disabled' : '') + '>' + esc('Add to ' + suggestion) + '</button>' : '') +
      '<button type="button" class="cx-btn quiet" data-sp="held-name" data-key="' + esc(key) + '"' + (disabledName ? ' disabled' : '') + '>' + (count === 1 ? 'Name this sample' : 'Name this voice') + '</button>' +
      '<button type="button" class="sp-text sp-danger-text" data-sp="held-discard" data-key="' + esc(key) + '"' + (H.busy ? ' disabled' : '') + '>Discard</button></div>';
  }
  function groupRow(g) {
    var meetings = g.sessions.length;
    var sug = '';
    if (g.suggestionName) {
      var p = Math.round(g.suggestionSimilarity * 100) + '%';
      sug = '<div class="sp-sug"><span class="sp-muted">' + (g.suggestionTier === 'high' ? 'Sounds like' : 'May be') + '</span> <b>' + esc(g.suggestionName) + '</b> ' +
        '<span class="sp-mono-s">' + esc(g.suggestionOf > 0 ? p + ' · ' + g.suggestionAgreeing + ' of ' + g.suggestionOf + ' samples agree' : p) + '</span></div>';
    }
    var note = noteFor('heldgroup:' + g.id);
    var naming = S.H.naming === g.id || S.H.confirmDiscard === g.id;
    return '<div class="sp-held-row">' + listenStrip(g.id, g.playOrder, 'heldgroup:' + g.id) +
      '<div class="sp-held-body"><div class="sp-held-head"><b>' + g.sampleCount + ' sample' + s(g.sampleCount) + '</b><span class="sp-caps">' + meetings + ' MEETING' + (meetings === 1 ? '' : 'S') + '</span></div>' +
      sug + (g.ownerCaution ? '<div class="sp-accent">Also close to the owner voice. Listen carefully.</div>' : '') +
      (note ? '<div class="sp-muted sp-small">' + esc(note) + '</div>' : '') + '</div>' +
      heldActions(g.id, g.sampleCount, !naming && g.suggestionName ? g.suggestionName : null) + '</div>';
  }
  function looseRow(x) {
    var key = 'loose:' + x.id, sg = x.suggestion;
    var note = noteFor('heldloose:' + x.id);
    var naming = S.H.naming === key || S.H.confirmDiscard === key;
    return '<div class="sp-held-row">' + listenStrip(key, [x], 'heldloose:' + x.id) +
      '<div class="sp-held-body"><div class="sp-held-head"><b>Loose sample</b></div>' +
      (sg ? '<div class="sp-accent sp-strong">' + esc('Sounds like ' + sg.name + ' · ' + Math.round(sg.similarity * 100) + '%') + '</div>' +
        '<div class="sp-mono-s">' + sg.agreeing + ' voice samples agree</div>' +
        (sg.ownerCaution ? '<div class="sp-accent">Also close to the owner voice. Listen carefully.</div>' : '')
        : '<div class="sp-muted">No existing voice suggestion</div>') +
      '<div class="sp-mono-s">' + esc(heldLabel(x.sessionId, x.chunkIndex)) + '</div>' +
      (note ? '<div class="sp-muted sp-small">' + esc(note) + '</div>' : '') + '</div>' +
      heldActions(key, 1, !naming && sg ? sg.name : null) + '</div>';
  }
  function statusBar(H) {
    var out = '';
    var interrupted = H.batches.filter(function (b) { return b.needsReview; }).length;
    if (interrupted > 0) out += '<button type="button" class="cx-btn quiet" data-sp="held-history">Review ' + interrupted + ' interrupted naming' + s(interrupted) + '</button>';
    else if (H.batches.length) out += '<button type="button" class="cx-btn quiet" data-sp="held-history">Recent naming (' + H.batches.length + ')</button>';
    var rc = H.receipt;
    if (rc) {
      out += '<button type="button" class="sp-text" data-sp="held-result">' + (rc.kind === 'undone' ? 'Undo result' : 'Naming result') + '</button>';
      if (rc.undoHandle && (rc.kind !== 'undone' || rc.partial)) {
        out += '<button type="button" class="cx-btn quiet" data-sp="held-undo-ask" data-handle="' + esc(rc.undoHandle) + '"' + (H.busy || !H.namingAvailable ? ' disabled' : '') + '>Undo labels</button>';
      }
    }
    if (H.historyError) out += '<span class="sp-muted sp-small">' + esc(H.historyError) + '</span>';
    out += '<span class="sp-grow"></span>';
    if (H.loose.length > 1) {
      out += H.confirmDiscard === 'loose-all'
        ? '<button type="button" class="cx-btn sp-danger" data-sp="held-discard-all-yes"' + (H.busy ? ' disabled' : '') + '>Discard all ' + H.loose.length + '?</button><button type="button" class="sp-text" data-sp="held-discard-no">Keep</button>'
        : '<button type="button" class="sp-text sp-danger-text" data-sp="held-discard-all"' + (H.busy ? ' disabled' : '') + '>Discard all loose</button>';
    }
    return '<div class="sp-status">' + out + '</div>';
  }
  function undoConfirm(H) {
    if (!H.confirmUndo) return '';
    return '<div class="sp-confirm" role="alertdialog" aria-label="Restore this naming’s previous labels?"><b>Restore this naming’s previous labels?</b>' +
      '<p class="sp-muted">Later naming is protected. Voice samples stay enrolled; deleted audio stays deleted.</p><div class="sp-inline">' +
      '<button type="button" class="cx-btn sp-danger" data-sp="held-undo-yes"' + (H.busy ? ' disabled' : '') + '>Undo labels</button>' +
      '<button type="button" class="sp-text" data-sp="held-undo-no">Keep labels</button></div></div>';
  }
  function samplesBody() {
    var H = S.H;
    var head = '<div class="sp-card-head"><span class="sp-add-glyph">' + icon('speakers') + '</span><h2 class="sp-card-title">Add a voice</h2><span class="sp-grow"></span>' +
      (H.loading && H.state != null ? spin() : '') + '</div>';
    var body = head + (H.result ? notice(H.result) : '');
    if (H.namingAvailable) body += statusBar(H);
    else if (H.state != null) body += '<p class="sp-muted sp-small">Update the COS server to 6.46.0 or newer to preview, apply and undo meeting labels.</p>';
    body += undoConfirm(H);
    if (H.sheet === 'preview' || (H.sheet === 'preview-wait')) return '<section class="sp-card">' + body + previewSheet(H) + '</section>';
    if (H.sheet === 'result') return '<section class="sp-card">' + body + resultSheet(H) + '</section>';
    if (H.sheet === 'history') return '<section class="sp-card">' + body + historySheet(H) + '</section>';
    if (H.state == null) body += '<p class="sp-muted sp-loading">' + spin() + 'Grouping held voices…</p>';
    else if (heldUsable(H)) {
      var rows = H.groups.length + H.loose.length;
      body += '<p class="sp-lead">' + esc(heldLead(H)) + '</p>';
      if (rows > 0) body += '<p class="sp-muted sp-small">' + esc(H.namingAvailable
        ? 'Preview first. Apply adds voice samples, labels matching segments in their own meetings, and uses up the audio. Discarding throws the audio out.'
        : 'Listen to or discard held audio. Naming needs server 6.46.0 or newer.') + '</p>';
      var all = H.groups.map(groupRow).concat(H.loose.map(looseRow));
      body += '<div class="sp-held-list">' + all.slice(0, H.shown).join('') + '</div>';
      if (all.length > H.shown) body += '<button type="button" class="cx-btn quiet sp-more" data-sp="held-more">Show ' + Math.min(ROW_PAGE, all.length - H.shown) + ' more of ' + (all.length - H.shown) + '</button>';
    } else {
      if (H.state === 'error' && H.error) body += notice('Voices could not be grouped: ' + H.error);
      else if (H.state === 'ready' && H.embedded === 0 && H.samples > 0) {
        body += notice(H.speakerModel ? H.samples + ' held samples are still being read for grouping. Refresh in a moment.'
          : H.samples + ' held samples cannot be grouped yet: the speaker model is not loaded on this Mac (Run checks shows it). The sessions are listed below.');
      }
      if (!H.extSessions.length) body += '<p class="sp-muted">' + esc(H.extError || 'No unrecognized audio is being held. Record a meeting, then come back within 72 hours.') + '</p>';
      else {
        body += '<p class="sp-muted">' + esc(H.extSessions.length > 5 ? H.extSessions.length + ' unrecognized sessions the server is holding. Naming one creates a new voice from it.'
          : 'Unrecognized audio the server is holding. Naming a session creates a new voice from it.') + '</p>' +
          '<p class="sp-muted sp-small">A session can hold more than one unknown speaker, and naming it uses up the audio.</p><div class="sp-held-list">' +
          H.extSessions.map(function (x) {
            var refs = x.chunkIndices.map(function (c) { return { sessionId: x.sessionId, chunkIndex: c, id: x.sessionId + '#' + c }; });
            var note = noteFor('held:' + x.sessionId);
            return '<div class="sp-held-row">' + listenStrip('ext:' + x.sessionId, refs, 'held:' + x.sessionId) +
              '<div class="sp-held-body"><b>' + x.chunks + ' sample' + s(x.chunks) + '</b><span class="sp-caps">EXPIRES IN ' + esc(x.expiresIn.toUpperCase()) + '</span>' +
              (note ? '<div class="sp-muted sp-small">' + esc(note) + '</div>' : '') + '</div>' +
              '<button type="button" class="cx-btn quiet" disabled title="Wait for sample grouping, or update the server to 6.46.0, to preview a name safely.">Name this voice</button></div>';
          }).join('') + '</div>';
      }
    }
    return '<section class="sp-card">' + body + '</section>';
  }

  // ── render: the naming sheets, inline (Control draws them as an overlay; the web keeps no fixed layers) ──
  function namingMeeting(m, showPlayback) {
    var out = '<div class="sp-nm"><div class="sp-nm-head"><b>' + esc(heldLabel(m.sessionId, null)) + '</b><span class="sp-caps">' + esc(m.status.toUpperCase()) + '</span></div>' +
      '<div class="sp-muted sp-small">' + m.named.length + ' named · ' + m.wider.length + ' wider matches · ' + m.labelled + ' transcript positions</div>';
    if (!m.wider.length && showPlayback && m.status === 'ready') out += '<div class="sp-muted sp-small">No wider match. The named segments still get a label.</div>';
    if (m.error) out += '<div class="sp-accent sp-strong">' + esc(m.error) + '</div>';
    if (m.roomRisk) out += '<div class="sp-accent sp-small">Room caution: all agreeing samples for a wider match came from this meeting. Listen carefully.</div>';
    if (m.labelsNewerThanGraph) out += '<div class="sp-caps sp-accent">LABELS NEWER THAN GRAPH</div>';
    m.copySummaries.forEach(function (c) { out += '<div class="sp-mono-s">' + esc(c) + '</div>'; });
    if (showPlayback) {
      if (!m.playback.length) out += '<div class="sp-muted sp-small">No mapped audio to play. Audio expired, vectors only, or no transcript position.</div>';
      else {
        var row = function (t) {
          var key = 'naming:' + t.id, playing = A.key === key;
          var score = null;
          m.widerScores.forEach(function (w) { if (w && int(w.chunkIndex) === t.chunkIndex && num(w.similarity) != null) score = num(w.similarity); });
          return '<div class="sp-inline"><button type="button" class="cx-btn quiet" data-sp="naming-play" data-sid="' + esc(t.sessionId) + '" data-chunk="' + t.chunkIndex + '" data-key="' + esc(key) + '">' +
            (playing ? 'Stop' : 'Listen · chunk ' + t.chunkIndex) + '</button><span class="sp-mono-s">' + (score != null ? 'Sounds like · ' + Math.round(score * 100) + '%' : 'Named sample') + '</span></div>';
        };
        out += m.playback.slice(0, 5).map(row).join('');
        if (m.playback.length > 5) out += '<details class="sp-fold"><summary>Listen to all ' + m.playback.length + ' segments</summary>' + m.playback.slice(5).map(row).join('') + '</details>';
      }
    }
    return out + '</div>';
  }
  function expiryLine(p) {
    if (!p.expiresAt) return 'Preview expiration unavailable. Preview again.';
    return p.expiresAt > new Date()
      ? 'Preview expires at ' + p.expiresAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '. If a meeting changes, preview again.'
      : 'This preview expired. Choose Preview name to refresh it.';
  }
  function previewSheet(H) {
    var p = H.preview;
    if (!p) {
      return '<div class="sp-sheet"><p>' + esc(H.busy ? 'Preparing a fresh preview…' : (H.result || 'Preview unavailable. Close and try again.')) + '</p>' +
        '<button type="button" class="sp-text" data-sp="sheet-cancel">Close</button></div>';
    }
    var out = '<div class="sp-sheet"><div class="sp-caps">PREVIEW · NO CHANGES YET</div><h3 class="sp-sheet-title">' + esc('Name this voice ' + p.speaker + '?') + '</h3>' +
      '<div class="sp-inline"><input class="field sp-field" id="sp-revised" type="text" placeholder="Who is this?" value="' + esc(H.revised) + '" autocomplete="off" aria-label="Who is this?">' +
      '<button type="button" class="cx-btn quiet" data-sp="sheet-repreview"' + (H.busy || H.revised.trim().length < 2 ? ' disabled' : '') + '>Preview name</button></div>' +
      '<p class="sp-strong">' + p.eligible + ' held sample' + s(p.eligible) + ' eligible · ' + p.labelled + ' transcript segment' + s(p.labelled) + ' in ' + p.meetings.length + ' meeting' + s(p.meetings.length) + '</p>' +
      '<p class="sp-muted sp-small">The server selects distinct voiceprints to keep. Apply reports how many were enrolled; naming several samples does not always add that many voiceprints.</p>';
    if (p.noTranscript > 0) out += '<p class="sp-muted sp-small">' + p.noTranscript + ' samples have no transcript position. They can help the voice profile without adding transcript labels.</p>';
    out += p.meetings.map(function (m) { return namingMeeting(m, true); }).join('');
    var note = noteFor('held-naming-preview');
    if (note) out += '<p class="sp-accent sp-small">' + esc(note) + '</p>';
    if (p.owner) {
      out += '<p class="sp-accent sp-strong">' + esc(p.ownerWarning || 'This is your owner voice. Confirm these samples are your own voice.') + '</p>' +
        '<label class="cx-check sp-toggle"><input type="checkbox" id="sp-owner-ack"' + (H.ownerAck ? ' checked' : '') + '>I confirm these samples are my own voice.</label>';
    }
    if (p.requiresListening) out += '<label class="cx-check sp-toggle"><input type="checkbox" id="sp-listened"' + (H.listened ? ' checked' : '') + '>I listened and these segments sound like the same person.</label>';
    out += '<p class="sp-muted sp-small" id="sp-expiry">' + esc(expiryLine(p)) + '</p><div class="sp-inline sp-sheet-foot">' +
      '<button type="button" class="sp-text" data-sp="sheet-cancel">Cancel</button><span class="sp-grow"></span>' + (H.busy ? spin() : '') +
      '<button type="button" class="cx-btn primary" data-sp="sheet-apply"' + (canApply(H) ? '' : ' disabled') + '>Apply</button></div></div>';
    return out;
  }
  function resultContent(rc) {
    var out = '<h3 class="sp-sheet-title">' + esc(rc.kind === 'undone' ? (rc.partial ? 'Some labels still need review' : 'Labels restored') : 'Naming ' + rc.speaker) + '</h3>';
    if (rc.error) out += '<p class="sp-accent sp-strong">' + esc(rc.error) + '</p>';
    if (rc.kind === 'undone') out += '<p class="sp-strong">' + rc.restored + ' segment' + s(rc.restored) + ' restored · ' + rc.labelled + ' remain' + (rc.labelled === 1 ? 's' : '') + ' labelled by this naming</p>';
    else if (rc.kind === 'applied') out += '<p class="sp-strong">' + rc.enrolled + ' sample' + s(rc.enrolled) + ' enrolled · ' + rc.labelled + ' segment' + s(rc.labelled) + ' labelled · ' + rc.deleted + ' audio sample' + s(rc.deleted) + ' deleted</p>';
    if (rc.profileEmbeddings != null) out += '<p class="sp-muted sp-small">' + rc.profileEmbeddings + ' voice samples retained in the profile</p>';
    if (rc.partial) out += '<p class="sp-accent sp-small">Some meetings or copies could not be completed. Review each outcome below.</p>';
    out += '<p class="sp-muted sp-small">Undo restores labels. Voice samples stay enrolled; deleted audio stays deleted. Search catches up at up to 10 meetings per sync; graph labels may lag.</p>';
    if (rc.lockMode === 'standalone') out += '<p class="sp-muted sp-small">Standalone meeting library: no COS sync lock was needed.</p>';
    out += rc.meetings.map(function (m) { return namingMeeting(m, false); }).join('');
    if (rc.outcomes.length) {
      out += '<details class="sp-fold"><summary>Sample outcomes (' + rc.outcomes.length + ')</summary>' + rc.outcomes.map(function (o) {
        return '<div class="sp-outcome"><div class="sp-mono-s">' + esc(heldLabel(o.sample.sessionId, o.sample.chunkIndex)) + '</div><div class="sp-muted sp-small">' +
          esc(o.noTranscript ? o.enrollmentStatus + ' · no transcript position · audio ' + o.audioStatus : 'Voice ' + o.enrollmentStatus + ' · labels ' + o.labelStatus + ' · audio ' + o.audioStatus) + '</div>' +
          (o.reason ? '<div class="sp-accent sp-small">' + esc(o.reason) + '</div>' : '') + '</div>';
      }).join('') + '</details>';
    }
    return out;
  }
  function resultSheet(H) {
    var rc = H.receipt;
    if (!rc) return '<div class="sp-sheet"><p>No naming receipt is selected.</p><button type="button" class="sp-text" data-sp="sheet-close">Close</button></div>';
    return '<div class="sp-sheet">' + resultContent(rc) + '<div class="sp-inline sp-sheet-foot"><button type="button" class="sp-text" data-sp="sheet-close">Close</button><span class="sp-grow"></span>' +
      (rc.undoHandle && (rc.kind !== 'undone' || rc.partial) ? '<button type="button" class="cx-btn quiet" data-sp="held-undo-ask" data-handle="' + esc(rc.undoHandle) + '"' + (H.busy || !H.namingAvailable ? ' disabled' : '') + '>Undo labels</button>' : '') +
      (H.busy ? spin() : '') + '</div></div>';
  }
  function historySheet(H) {
    var out = '<div class="sp-sheet"><h3 class="sp-sheet-title">Recent naming</h3><p class="sp-muted">Interrupted naming never resumes automatically. Resume opens a fresh preview; Revert restores this naming’s labels where later changes allow it.</p>';
    if (!H.namingAvailable) out += '<p>Update the COS server to 6.46.0 or newer to review and undo naming.</p>';
    if (H.result) out += '<p class="sp-accent">' + esc(H.result) + '</p>';
    out += H.batches.map(function (b) {
      return '<div class="sp-batch"><div class="sp-nm-head"><b>' + esc(b.speaker) + '</b><span class="sp-caps sp-accent">' + esc(b.needsReview ? 'INTERRUPTED NAMING' : b.status.toUpperCase()) + '</span></div>' +
        b.meetings.map(function (m) { return namingMeeting(m, false); }).join('') + '<div class="sp-inline">' +
        (b.needsReview ? '<button type="button" class="cx-btn primary" data-sp="held-resume" data-batch="' + esc(b.batchId) + '"' + (H.busy || !H.namingAvailable ? ' disabled' : '') + '>Resume</button>' : '') +
        (b.undoHandle && b.status !== 'reverted' ? '<button type="button" class="cx-btn quiet" data-sp="held-undo-ask" data-handle="' + esc(b.undoHandle) + '"' + (H.busy || !H.namingAvailable ? ' disabled' : '') + '>' + (b.needsReview ? 'Revert labels' : 'Undo labels') + '</button>' : '') +
        '</div></div>';
    }).join('');
    return out + '<p class="sp-muted sp-small">Voice samples stay enrolled. Audio is never restored. Per-copy results show any labels that could not be reverted.</p>' +
      '<div class="sp-inline sp-sheet-foot"><button type="button" class="sp-text" data-sp="sheet-close">Close</button>' + (H.busy ? spin() : '') + '</div></div>';
  }

  // ── render: Voices (the directory) ─────────────────────
  // CONFIDENCE is the share of SCORED segments the server rated confident; under 10 scored it is marked thin.
  function confShare(p) {
    if (!(p.observedMatchSegments > 0)) return null;
    return Math.min(1, (p.reliabilityCounts.confident || 0) / p.observedMatchSegments);
  }
  function confValue(p) { var x = confShare(p); return x == null ? '–' : pct(x); }
  function confDetail(p) {
    if (p.observedMatch == null || !(p.observedMatchSegments > 0)) return 'not matched yet';
    var avg = 'avg ' + two(p.observedMatch);
    return p.observedMatchSegments < 10 ? avg + ' · thin' : avg;
  }
  function confRank(p) { var x = confShare(p); return x == null ? { tier: 2, share: null } : { tier: p.observedMatchSegments < 10 ? 1 : 0, share: x }; }
  function sourceLine(p) {
    var rows = Object.keys(p.sources).filter(function (k) { return p.sources[k] > 0; }).sort(function (a, b) {
      return p.sources[a] === p.sources[b] ? (a < b ? -1 : 1) : p.sources[b] - p.sources[a];
    });
    var out = rows.slice(0, 2).map(function (k) { return k + ' ' + p.sources[k]; }).join(' · ');
    return out || 'No recorded source';
  }
  function visibleVoices() {
    var needle = S.voiceSearch.trim().toLowerCase();
    var list = (S.dir || []).filter(function (p) {
      return !needle || p.name.toLowerCase().indexOf(needle) >= 0 || Object.keys(p.sources).some(function (k) { return k.toLowerCase().indexOf(needle) >= 0; });
    });
    return list.sort(function (a, b) {
      var sort = S.voiceSort;
      if (sort === 'attention') {
        var na = needsAttention(a), nb = needsAttention(b);
        if (na !== nb) return na ? -1 : 1;
        if (a.reviewMeetingCount !== b.reviewMeetingCount) return b.reviewMeetingCount - a.reviewMeetingCount;
        if (a.meetingCount !== b.meetingCount) return b.meetingCount - a.meetingCount;
      } else if (sort === 'recent') {
        if ((a.lastSeen || '') !== (b.lastSeen || '')) return (a.lastSeen || '') > (b.lastSeen || '') ? -1 : 1;
      } else if (sort === 'meetings') {
        if (a.meetingCount !== b.meetingCount) return b.meetingCount - a.meetingCount;
      } else if (sort === 'samples') {
        if (a.embeddings !== b.embeddings) return b.embeddings - a.embeddings;
      } else if (sort === 'confidence') {
        var ra = confRank(a), rb = confRank(b);
        if (ra.tier !== rb.tier) return ra.tier - rb.tier;
        if (ra.share != null && rb.share != null && ra.share !== rb.share) return ra.share - rb.share;
        if (a.observedMatchSegments !== b.observedMatchSegments) return b.observedMatchSegments - a.observedMatchSegments;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }
  function metric(value, sub, cls) {
    return '<span class="sp-metric ' + cls + '"><b>' + esc(value) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>';
  }
  function voiceRowHtml(p) {
    var hist = S.dirRoute !== false;
    var pillsHtml = (p.isOwner ? '<span class="cx-pill ok">OWNER</span>' : '') + (needsAttention(p) ? '<span class="cx-pill warn">REVIEW</span>' : '');
    var stack = [fmt(p.embeddings) + ' sample' + s(p.embeddings)];
    if (hist) {
      stack.push(confValue(p) + ' ' + confDetail(p));
      stack.push(fmt(p.meetingCount) + ' meeting' + s(p.meetingCount) + (p.reviewMeetingCount > 0 ? ' (' + fmt(p.reviewMeetingCount) + ' review)' : ''));
      stack.push(fmt(p.assertedSegments) + ' segments' + (p.candidateSegments > 0 ? ' +' + fmt(p.candidateSegments) + ' review' : ''));
      stack.push(p.lastSeen || 'Never');
    }
    return '<button type="button" class="sp-vrow" data-sp="open-voice" data-name="' + esc(p.name) + '" aria-label="' + esc(p.name + ', ' + p.embeddings + ' training samples') + '">' +
      '<span class="cx-row-glyph sp-vglyph">' + icon('speakers') + '</span>' +
      '<span class="sp-vname"><span class="sp-vtitle"><b>' + esc(p.name) + '</b>' + pillsHtml + '</span><span class="sp-vsrc">' + esc(sourceLine(p)) + '</span>' +
      '<span class="sp-vstack">' + esc(stack.join(' · ')) + '</span></span>' +
      metric(fmt(p.embeddings), null, 'c-samples') +
      metric(hist ? confValue(p) : '–', hist ? confDetail(p) : 'update server', 'c-conf') +
      metric(hist ? fmt(p.meetingCount) : '–', hist && p.reviewMeetingCount > 0 ? fmt(p.reviewMeetingCount) + ' review' : null, 'c-count') +
      metric(hist ? fmt(p.assertedSegments) : '–', hist && p.candidateSegments > 0 ? '+' + fmt(p.candidateSegments) + ' review' : null, 'c-count') +
      metric(hist ? (p.lastSeen || 'Never') : '–', null, 'c-seen') + '<span class="chev"></span></button>';
  }
  function dirNotice(text, stale) { return '<div class="sp-dnotice' + (stale ? ' stale' : '') + '">' + esc(text) + '</div>'; }
  function voicesBody() {
    var dir = S.dir;
    if (S.dirLoading && (!dir || !dir.length)) return '<p class="cx-note sp-loading">' + spin() + 'Building the voice directory…</p>';
    if (!dir || !dir.length) {
      if (S.dirLoadFailed) {
        return '<div class="sp-empty"><span class="cx-glyph">' + icon('speakers') + '</span><p class="sp-strong">The voice directory could not be loaded.</p><p>' +
          esc(S.dirError || 'The helper did not answer.') + '</p><button type="button" class="cx-btn quiet" data-sp="dir-retry">Retry</button></div>';
      }
      if (!dir) return '';
      return '<div class="sp-empty"><span class="cx-glyph">' + icon('speakers') + '</span><p class="sp-strong">No voice profiles are enrolled yet.</p><p>' +
        esc('Voices the glasses did not recognize are held for 72 hours under Samples to review. Listen to one and name it to start a profile, or say "enroll my voice" on the glasses.') +
        '</p><button type="button" class="cx-btn primary" data-sp="view" data-view="samples">Open Samples to review</button></div>';
    }
    var out = '';
    if (S.dirError) out += dirNotice(S.dirError, S.dirRoute !== false);
    if (S.unresolvedMeetings > 0) out += dirNotice(fmt(S.unresolvedSegments) + ' unidentified segments remain local to ' + fmt(S.unresolvedMeetings) + ' meeting' + s(S.unresolvedMeetings) + '. They are not treated as one person.', false);
    var rows = visibleVoices();
    out += '<div class="sp-dir"><div class="sp-dhead" aria-hidden="true"><span class="sp-vname">VOICE</span><span class="c-samples">SAMPLES</span>' +
      '<span class="c-conf">CONFIDENCE</span><span class="c-count">MEETINGS</span><span class="c-count">SEGMENTS</span><span class="c-seen">LAST SEEN</span><span class="chev-space"></span></div>' +
      rows.map(voiceRowHtml).join('');
    if (!rows.length) out += '<div class="sp-nomatch"><p>' + esc('No voices match “' + S.voiceSearch + '”.') + '</p><button type="button" class="cx-btn quiet" data-sp="clear-search">Clear search</button></div>';
    return out + '</div>';
  }
  function voiceDetail(name) {
    var p = (S.dir || []).filter(function (x) { return x.name === name; })[0];
    if (!p) {
      if (S.dirLoading || !S.dir) return '<div class="cx">' + W.skeletonRows(4) + '</div>';
      return '<div class="cx"><div class="cx-notice warn">' + esc('No enrolled voice is named “' + name + '”.') + '</div></div>';
    }
    W.setCrumb(p.name);
    var hist = S.dirRoute !== false;
    function card(title, value, detail) {
      return '<div class="sp-mcard"><span class="sp-caps">' + esc(title) + '</span><b>' + esc(value) + '</b><small>' + esc(detail) + '</small></div>';
    }
    function info(title, rows, warning) {
      return '<div class="sp-icard"><b>' + esc(title) + '</b>' + rows.map(function (r) { return '<span>' + esc(r) + '</span>'; }).join('') +
        (warning ? '<span class="sp-warnline">⚠︎ ' + esc(warning) + '</span>' : '') + '</div>';
    }
    var srcRows = Object.keys(p.sources).sort().map(function (k) { return k + ': ' + p.sources[k] + ' sample' + s(p.sources[k]); });
    var out = '<div class="cx sp-voice" data-tint="speakers"><div class="sp-vhead"><span class="cx-glyph">' + icon('speakers') + '</span><div>' +
      '<h2 class="sp-vh-title">' + esc(p.name) + (p.isOwner ? ' <span class="cx-pill ok">OWNER</span>' : '') + (needsAttention(p) ? ' <span class="cx-pill warn">NEEDS REVIEW</span>' : '') + '</h2>' +
      '<p class="sp-mono">Enrolled identity · ' + p.embeddings + ' training samples</p></div></div>' +
      '<div class="sp-mcards">' +
      card('CONFIDENCE', hist ? confValue(p) : '–', hist ? (p.observedMatch != null ? 'avg match ' + two(p.observedMatch) + ' · ' + fmt(p.observedMatchSegments) + ' scored' : 'Not matched yet') : 'Update server') +
      card('ATTRIBUTED', hist ? String(p.assertedSegments) : '–', hist ? 'segments' : 'History unavailable') +
      card('MEETINGS', hist ? String(p.meetingCount) : '–', hist ? (p.reviewMeetingCount > 0 ? p.reviewMeetingCount + ' need review' : 'asserted') : 'History unavailable') +
      card('LAST HEARD', hist ? (p.lastSeen || 'Never') : '–', hist ? (p.firstSeen ? 'since ' + p.firstSeen : 'No occurrence') : 'History unavailable') + '</div>' +
      '<div class="sp-icards">' +
      info('Training provenance', srcRows.length ? srcRows : ['No provenance recorded'], p.sourcesAligned ? null : 'Sample and provenance counts do not align.') +
      info('Observed evidence', hist ? [p.assertedSegments + ' attributed segments', formatDuration(p.assertedSpeakingMs) + ' credited speaking time', p.candidateSegments + ' candidate segments awaiting review']
        : ['Cross-meeting evidence requires the Voice Directory server route.'], hist && p.candidateSegments > 0 ? 'Candidates are not counted as confirmed identity.' : null) + '</div>' +
      '<div class="sp-caps sp-hist-label">MEETING HISTORY</div>';
    if (!p.appearances.length) {
      out += '<p class="sp-muted">' + esc(S.dirRoute === false ? 'Update the server to add meeting history.' : 'No attributed meeting appearances are available yet.') + '</p>';
    } else {
      out += '<div class="cx-list sp-list">' + p.appearances.map(function (a) {
        return '<button type="button" class="cx-row sp-arow" data-sp="open-appearance" data-sid="' + esc(a.sessionId) + '">' +
          '<span class="cx-row-glyph' + (a.needsReview ? ' sp-amber' : '') + '">' + icon('speakers') + '</span><span class="cx-row-body">' +
          '<span class="cx-row-title strong sp-one">' + esc(a.title) + '</span><span class="sp-mono">' + esc(a.date + ' · ' + a.segments + ' segments · ' + formatDuration(a.speakingMs)) + '</span></span>' +
          '<span class="sp-match"><b>' + esc(a.observedMatch == null ? '–' : pct(a.observedMatch)) + '</b><small>' + (a.confirmedByHuman ? 'human confirmed' : a.needsReview ? 'review' : 'observed match') + '</small></span>' +
          '<span class="chev"></span></button>';
      }).join('') + '</div>';
    }
    return out + '</div>';
  }

  // ── render: the review (SpeakerReviewPane) ─────────────
  var PALETTE = ['var(--green)', 'var(--amber)', 'color-mix(in srgb, var(--ink) 55%, transparent)', 'color-mix(in srgb, var(--green) 55%, transparent)', 'color-mix(in srgb, var(--amber) 55%, transparent)'];
  function speakerOrder(rv) {
    var seen = {}, out = [];
    rv.timeline.forEach(function (t) { if (!seen[t.speaker]) { seen[t.speaker] = true; out.push(t.speaker); } });
    return out;
  }
  // An unnamed voice stays neutral: colouring it like a person would imply an identity nobody has.
  function tint(rv, speaker, order) {
    if (!assertsName(rv, speaker)) return 'var(--sp-line)';
    var i = order.indexOf(speaker);
    return i < 0 ? 'var(--sp-line)' : PALETTE[i % PALETTE.length];
  }
  // Fixed-width columns, each won by whoever holds most of that slice (TurnRibbon.columns).
  function columns(rv, count) {
    var spanMs = Math.max(rv.timeline.length ? rv.timeline[rv.timeline.length - 1].endMs : 0, rv.durationMs, 1);
    var slice = spanMs / count, out = [], cursor = 0;
    for (var i = 0; i < count; i++) {
      var from = Math.floor(i * slice), to = Math.floor((i + 1) * slice), best = '', bestMs = 0, j = cursor;
      while (j < rv.timeline.length && rv.timeline[j].startMs < to) {
        var t = rv.timeline[j], overlap = Math.min(t.endMs, to) - Math.max(t.startMs, from);
        if (overlap > bestMs) { bestMs = overlap; best = t.speaker; }
        if (t.endMs <= to) j++; else break;
      }
      cursor = Math.max(cursor, j - 1);
      if (!best && out.length) best = out[out.length - 1].speaker;
      out.push({ speaker: best, startMs: from });
    }
    return out;
  }
  function ribbon(R) {
    var rv = R.review, order = speakerOrder(rv);
    var width = Math.max(200, (pane.clientWidth || 360) - 40);
    var cols = R.cols = columns(rv, Math.max(1, Math.min(Math.floor(width / 2.5), 200)));
    var span = R.hovered != null ? rv.timeline[R.hovered] : null;
    var hint = hoverless() ? 'Tap the bar to see who is speaking' : 'Hover the bar to see who is speaking';
    return '<div class="sp-tl"><div class="sp-caps sp-tl-label">WHO SPOKE, IN ORDER</div>' +
      '<div class="sp-bar" id="sp-bar" role="img" aria-label="Who spoke, in order">' + cols.map(function (c, i) {
        var hl = span && R.hoveredCol === i;
        return '<span style="background:' + tint(rv, c.speaker, order) + '"' + (R.hoveredCol != null && !hl ? ' class="dim"' : '') + '></span>';
      }).join('') + '</div>' +
      '<div class="sp-tl-read" id="sp-tl-read">' + (span ? '<span class="sp-mono-s">' + stamp(span.startMs) + '</span> <b>' + esc(displayNameOf(rv, span.speaker)) + '</b> <span class="sp-mono-s">' +
        span.segments + ' seg · ' + Math.max(1, Math.floor((span.endMs - span.startMs) / 1000)) + 's</span>' : '<span class="sp-muted sp-small">' + hint + '</span>') + '</div>' +
      '<div class="sp-legend">' + order.map(function (sp) {
        return '<button type="button" class="sp-leg' + (assertsName(rv, sp) ? '' : ' dim') + '" data-sp="legend" data-speaker="' + esc(sp) + '"><i style="background:' + tint(rv, sp, order) + '"></i>' + esc(displayNameOf(rv, sp)) + '</button>';
      }).join('') + '</div></div>';
  }
  function ramp(v) {
    var unreliable = v.reliability === 'unreliable', val = v.meanSimilarity, bars = '';
    for (var i = 0; i < 10; i++) bars += '<i' + (i < (val || 0) * 10 && !unreliable ? ' class="lit"' : '') + '></i>';
    return '<span class="sp-ramp"><span class="sp-ramp-bars">' + bars + '</span><span class="sp-mono-s">' + (unreliable ? 'unreliable' : val != null ? two(val) : '–') + '</span></span>';
  }
  function matchesFor(R, v, typed) {
    var q = String(typed || '').trim().toLowerCase();
    if (!q) return [];
    var mac = R.review.isMac;
    return (S.profiles || []).filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0 && p.name !== v.label && !(mac && p.isOwner); }).slice(0, 4);
  }
  function typedNew(R, label, typed) {
    var name = String(typed || '').trim();
    if (name.length < 2 || name === label) return null;
    return (S.profiles || []).some(function (p) { return p.name.toLowerCase() === name.toLowerCase(); }) ? null : name;
  }
  function namingOptions(R, v) {
    var typed = R.typed[v.label] || '';
    var busy = R.busy ? ' disabled' : '';
    return matchesFor(R, v, typed).map(function (o) {
      return '<button type="button" class="sp-opt" data-sp="rename-pick" data-label="' + esc(v.label) + '" data-name="' + esc(o.name) + '"' + busy + '><span>' + esc(o.name) + '</span>' +
        (R.busy ? spin() : '<span class="sp-mono-s">' + o.embeddings + ' samples</span>') + '</button>';
    }).join('') + (function () {
      var n = typedNew(R, v.label, typed);
      return n ? '<button type="button" class="sp-opt" data-sp="rename-new" data-label="' + esc(v.label) + '" data-name="' + esc(n) + '"' + busy + '><span>' + esc('Use “' + n + '”') + '</span>' +
        '<span class="sp-mono-s">' + (R.review.isMac ? 'text only' : 'new name') + '</span></button>' : '';
    })();
  }
  function scopeSwitch(R) {
    return '<div class="cx-switch sp-scope" role="group" aria-label="Correction scope">' +
      [['thisMeeting', 'Just this meeting'], ['everywhere', 'Every meeting']].map(function (o) {
        return '<button type="button" data-sp="scope" data-scope="' + o[0] + '" aria-pressed="' + (R.scope === o[0]) + '">' + o[1] + '</button>';
      }).join('') + '</div><p class="sp-tert">' + esc(R.scope === 'thisMeeting'
        ? 'Corrects this meeting and adds samples to the voice profile. Other meetings are left alone.'
        : 'Folds one profile into the other across every meeting. Cannot be undone here.') + '</p>';
  }
  function voiceRow(R, v, hintSeconds) {
    var rv = R.review, out = '<div class="sp-voice-row" data-row="' + esc(v.label) + '"><div class="sp-vr-head">' +
      '<b class="' + (v.nameAsserted ? '' : 'sp-dimname') + '">' + esc(v.displayName) + '</b>' + (v.isOwner ? '<span class="sp-you">you</span>' : '') + '<span class="sp-grow"></span>' +
      '<span class="sp-mono-s">' + esc(v.kind ? (v.wordCount != null ? v.wordCount + ' words' : 'word timings') : v.segments + ' seg') + '</span>';
    if ((v.nameAsserted || v.kind) && v.speakingMs > 0) {
      out += '<span class="sp-mono-s">· ' + mmss(v.speakingMs) + '</span>';
      var share = shareOf(rv, v);
      if (share != null) out += '<span class="sp-mono-s sp-ink">· ' + pct(share) + '</span>';
    }
    if (hintSeconds != null) out += '<span class="sp-mono-s">· ' + secs(hintSeconds) + '</span>';
    if (!v.kind) out += ramp(v);
    out += '</div>';
    if (!v.phrases.length) {
      out += '<p class="sp-tert">' + (v.kind ? 'Word timings are retained for this speech.' : 'No line from this voice was distinctive enough to quote.') + '</p>';
    } else {
      out += '<div class="sp-phrases' + (v.reliability === 'unreliable' ? ' loose' : '') + '">' + v.phrases.map(function (ph) {
        var can = ph.chunkIndex != null && R.chunks[ph.chunkIndex];
        var key = v.label + '#' + (ph.chunkIndex == null ? -1 : ph.chunkIndex);
        return '<div class="sp-phrase">' + (can ? '<button type="button" class="sp-pplay' + (A.key === key ? ' on' : '') + '" data-sp="phrase" data-label="' + esc(v.label) + '" data-chunk="' + ph.chunkIndex + '" title="Hear this line" aria-label="' + (A.key === key ? 'Stop' : 'Hear this line') + '">' +
          (A.key === key ? '<span class="sp-stop-glyph"></span>' : '<span class="sp-play-glyph"></span>') + '</button>' : '<span class="sp-pplay-space"></span>') +
          '<span class="sp-ptext">“' + esc(ph.text) + '”</span><span class="sp-mono-s sp-tert">' + stamp(ph.atMs) + '</span></div>';
      }).join('') + '</div>';
    }
    if (v.thrash.length) out += '<p class="sp-muted sp-small">' + esc('Swaps with ' + v.thrash[0].speaker + ' every ' + Math.round(v.thrash[0].meanRun) + ' segments. Real turn-taking holds far longer, so a name here would be a guess.') + '</p>';
    if (!v.nameAsserted && v.reliability !== 'unattributed') {
      out += '<div class="sp-closest"><span>' + esc('Closest match: ' + v.label + (v.meanSimilarity != null ? ' (' + two(v.meanSimilarity) + ')' : '')) + '</span>' +
        v.blockers.map(function (b) { return '<span class="sp-tert">· ' + esc(b) + '</span>'; }).join('') + '</div>';
    }
    var note = noteFor(v.label);
    if (note) out += '<p class="sp-tert">' + esc(note) + '</p>';
    suggestionsFor(R, [v.label]).forEach(function (sg) { out += suggestionLine(R, sg, 1, [v.label]); });
    out += voiceNaming(R, v);
    return out + '</div>' + actionZone(R, v.label);
  }
  function suggestionLine(R, sg, rowSize, rowLabels) {
    var text = rowSize > 1 ? 'Suggested: ' + sg.name + ' for ' + sg.labels.length + ' of ' + rowSize + ' voices' : 'Suggested: ' + sg.name;
    return '<div class="sp-suggest"><span class="sp-strong">' + esc(text) + '</span><span class="sp-mono-s">' + two(sg.score) + '</span>' +
      '<button type="button" class="cx-btn quiet" data-sp="use-suggestion" data-id="' + esc(sg.id) + '" data-rows="' + esc(rowLabels.join('|')) + '"' + (R.busy ? ' disabled' : '') + '>Use this name</button></div>';
  }
  function voiceNaming(R, v) {
    var rv = R.review;
    if (rv.groupScopeLabels.indexOf(v.label) >= 0) return '<p class="sp-muted sp-small">This voice has a reviewed group. Name it in COS Control on your Mac.</p>';
    if (!rv.mutable) {
      return '<p class="sp-muted sp-small sp-lock">' + esc(!rv.intervalReadOnly ? 'Read-only library · new COS meetings remain editable' : 'Read-only interval view · naming needs an exact reviewed range') + '</p>';
    }
    if (!v.canRename) return '';
    var busy = R.busy ? ' disabled' : '';
    if (R.naming === v.label) {
      return '<div class="sp-naming"><input class="field sp-field" type="text" id="sp-name-input" data-label="' + esc(v.label) + '" placeholder="Type a name" value="' + esc(R.typed[v.label] || '') + '" autocomplete="off" aria-label="Type a name">' +
        (rv.isMac ? '<p class="sp-tert">' + esc(isVoiceLabel(v.label) ? MAC_RENAME_NOTE : MAC_RENAME_NOT_VOICE) + '</p>' : scopeSwitch(R)) +
        '<div class="sp-opts" id="sp-opts">' + namingOptions(R, v) + '</div>' +
        '<button type="button" class="sp-text" data-sp="naming-cancel">Cancel</button></div>';
    }
    var out = v.isNameAssignment ? '<p class="sp-tert">This voice was never named. Name it, or leave it unidentified.</p>' : '';
    out += '<div class="sp-inline sp-vacts"><button type="button" class="cx-btn quiet" data-sp="naming-open" data-label="' + esc(v.label) + '">' +
      (v.isNameAssignment ? 'Name this voice' : (v.reliability === 'unreliable' ? 'This is someone else' : 'Actually someone else')) + '</button>';
    if (v.canConfirmCandidate) {
      if (v.confirmsInOneClick) out += '<button type="button" class="cx-btn quiet" data-sp="confirm-voice" data-label="' + esc(v.label) + '"' + busy + '>' + esc('Yes, this is ' + v.label) + '</button>';
      else {
        out += R.confirmMenu === v.label
          ? '<button type="button" class="cx-btn quiet" data-sp="confirm-voice" data-label="' + esc(v.label) + '"' + busy + '>' + esc('Yes, I checked: this is ' + v.label) + '</button>'
          : '<button type="button" class="cx-btn quiet sp-clip" data-sp="confirm-menu" data-label="' + esc(v.label) + '"' + busy + '>' + esc('It is ' + v.label + '…') + '</button>';
      }
    }
    if (v.canDeattribute) out += '<button type="button" class="cx-btn quiet" data-sp="deattribute" data-label="' + esc(v.label) + '"' + busy + '>Not in this meeting</button>';
    return out + '</div>';
  }
  function mergedRow(R, row) {
    var rv = R.review, open = !!R.expanded[row.id];
    var labels = row.members.map(function (v) { return v.label; });
    var out = '<div class="sp-voice-row sp-merged" data-row="' + esc(row.id) + '"><button type="button" class="sp-mhead" data-sp="toggle-row" data-id="' + esc(row.id) + '" aria-expanded="' + open + '" title="' +
      (open ? 'Hide the voices in this group' : 'Show the voices and words in this group') + '"><span class="sp-disc' + (open ? ' open' : '') + '"></span><b class="sp-dimname">' + esc(rowTitle(labels)) + '</b><span class="sp-grow"></span>' +
      '<span class="sp-mono-s">' + row.members.length + ' labels</span>' + (row.seconds != null ? '<span class="sp-mono-s">· ' + secs(row.seconds) + '</span>' : '') + '</button>' +
      '<p class="sp-tert">Machine grouping, not confirmed as one voice.</p>';
    suggestionsFor(R, labels).forEach(function (sg) { out += suggestionLine(R, sg, row.members.length, labels); });
    var together = row.members.every(function (v) { return canNameAlone(rv, v); });
    if (together) {
      if (R.naming === row.id) {
        var typed = R.typed[row.id] || '';
        out += '<div class="sp-naming"><input class="field sp-field" type="text" id="sp-name-input" data-label="' + esc(row.id) + '" placeholder="Type a name" value="' + esc(typed) + '" autocomplete="off" aria-label="Type a name">' +
          '<p class="sp-tert">' + esc(MAC_RENAME_NOTE + ' Applies to each of the ' + row.members.length + ' labels.') + '</p><div class="sp-opts" id="sp-opts">' + groupOptions(R, row) + '</div>' +
          '<button type="button" class="sp-text" data-sp="naming-cancel">Cancel</button></div>';
      } else out += '<button type="button" class="cx-btn quiet" data-sp="naming-open" data-label="' + esc(row.id) + '"' + (R.busy ? ' disabled' : '') + '>Name this group</button>';
    } else if (rv.mutable) out += '<p class="sp-tert">Name these from their own rows, because at least one has its own reviewed path.</p>';
    if (open) out += '<div class="sp-members">' + row.members.map(function (v) { return voiceRow(R, v, rv.layout.seconds[v.label]); }).join('') + '</div>';
    return out + '</div>' + actionZone(R, row.id);
  }
  function groupOptions(R, row) {
    var typed = String(R.typed[row.id] || '').trim(), q = typed.toLowerCase(), busy = R.busy ? ' disabled' : '';
    var out = q ? (S.profiles || []).filter(function (p) { return p.name.toLowerCase().indexOf(q) >= 0 && !p.isOwner; }).slice(0, 4).map(function (o) {
      return '<button type="button" class="sp-opt" data-sp="group-pick" data-id="' + esc(row.id) + '" data-name="' + esc(o.name) + '"' + busy + '><span>' + esc(o.name) + '</span>' +
        (R.busy ? spin() : '<span class="sp-mono-s">' + o.embeddings + ' samples</span>') + '</button>';
    }).join('') : '';
    if (typed.length >= 2 && !(S.profiles || []).some(function (p) { return p.name.toLowerCase() === q; })) {
      out += '<button type="button" class="sp-opt" data-sp="group-new" data-id="' + esc(row.id) + '" data-name="' + esc(typed) + '"' + busy + '><span>' + esc('Use “' + typed + '”') + '</span><span class="sp-mono-s">text only</span></button>';
    }
    return out;
  }

  // Control pins these at the bottom of its panel; on the web they sit under the row they are about, so a phone sees them.
  function actionZone(R, anchor, force) {
    if (!force && (R.anchor || null) !== anchor) return '';
    R.zoneDrawn = true;
    var out = '';
    if (R.error) {
      out += '<div class="sp-banner" role="alert"><span>' + esc(R.error) + '</span><span class="sp-grow"></span>' +
        '<button type="button" class="sp-text" data-sp="retry">Try again</button><button type="button" class="sp-text" data-sp="dismiss">Dismiss</button></div>';
    }
    if (R.groupProgress) out += '<div class="sp-progress">' + spin() + '<span>' + esc(R.groupProgress) + '</span></div>';
    if (R.groupPlan) out += groupCard(R, R.groupPlan);
    if (R.groupOutcome) out += '<div class="sp-banner"><span>' + esc(R.groupOutcome) + '</span><span class="sp-grow"></span><button type="button" class="sp-text" data-sp="dismiss-outcome">Dismiss</button></div>';
    if (R.pending) out += correctionCard(R, R.pending);
    return out ? '<div class="sp-zone" id="sp-zone">' + out + '</div>' : '';
  }
  function groupCard(R, plan) {
    var segs = plan.corrections.reduce(function (t, c) { return t + c.surfaces.sidecar; }, 0);
    var lines = plan.corrections.reduce(function (t, c) { return t + c.surfaces.transcript; }, 0);
    var requested = plan.corrections.some(function (c) { return c.assignment || c.assignUnsupported; });
    var adding = plan.corrections.filter(function (c) { return addsSamples(c) && !needsForce(c); }).length;
    var flagged = plan.corrections.filter(needsForce).length;
    var out = '<div class="sp-ccard"><b>' + esc('Name ' + plan.labels.length + ' voice labels “' + plan.to + '”?') + '</b>' +
      '<p class="sp-muted">Saves each label in this meeting, one at a time. The grouping is a machine estimate, so check its words first.</p>';
    if (segs > 0) out += '<p class="sp-mono-s sp-tert">' + segs + ' segment(s)' + (lines > 0 ? ' · ' + lines + ' transcript line(s)' : '') + '</p>';
    if (requested) {
      if (adding > 0) out += '<p class="sp-muted sp-small">' + esc(adding + ' of ' + plan.labels.length + ' labels add voice samples to ' + plan.to + '’s profile.') + '</p>';
      if (flagged > 0) out += '<p class="sp-muted sp-small">' + flagged + ' were flagged by the voice checks and stay text only. To add those anyway, name them on their own rows.</p>';
      if (plan.corrections.some(function (c) { return c.assignUnsupported; })) out += '<p class="sp-muted sp-small">' + esc(MAC_UNSUPPORTED) + '</p>';
    } else out += '<p class="sp-muted sp-small">' + esc(MAC_TYPED_NOTE) + '</p>';
    return out + '<div class="sp-inline"><button type="button" class="cx-btn primary" data-sp="group-save"' + (R.busy ? ' disabled' : '') + '>Save</button>' +
      '<button type="button" class="cx-btn quiet" data-sp="group-cancel"' + (R.busy ? ' disabled' : '') + '>Cancel</button></div></div>';
  }
  function correctionTitle(c) {
    if (c.refused) return 'Not applied';
    if (c.to == null) return 'Remove ' + c.from + ' from this meeting?';
    return c.scope === 'thisMeeting' ? 'Rename ' + c.from + ' to ' + c.to + ' in this meeting?' : 'Rename ' + c.from + ' to ' + c.to + ' everywhere?';
  }
  function correctionCard(R, c) {
    var rv = R.review, busy = R.busy ? ' disabled' : '';
    var out = '<div class="sp-ccard" role="dialog" aria-label="' + esc(correctionTitle(c)) + '"><b>' + esc(correctionTitle(c)) + '</b><p class="sp-muted">' + esc(c.message) + '</p>';
    function line(t, cls) { out += '<p class="' + (cls || 'sp-muted sp-small') + '">' + esc(t) + '</p>'; }
    if (!c.refused && c.surfaces.sidecar > 0) {
      line(c.surfaces.sidecar + ' segment(s)' + (c.surfaces.transcript > 0 ? ' · ' + c.surfaces.transcript + ' transcript line(s)' : '') + (c.surfaces.attendees > 0 ? ' · attendee list' : ''), 'sp-mono-s sp-tert');
    }
    if (c.isNameAssignment && !c.refused && c.surfaces.sidecar > 0) {
      line('This voice was never matched to anyone, so nothing has established it is one person. Saving labels all ' + c.surfaces.sidecar + ' of its segments ' + (c.to || '') + '.');
    }
    if (rv && rv.isMac && !c.refused && c.to != null) {
      var al = c.assignUnsupported ? [MAC_UNSUPPORTED] : (c.assignment ? assignLines(c.assignment, c.from) : []);
      if (al.length) al.forEach(function (t) { line(t); }); else line(MAC_TYPED_NOTE);
    }
    if (c.createsProfile && !c.refused) line('This name is not in voice profiles yet. Saving adds it so other segments in this meeting can use it.');
    if (c.wouldRetract > 0) line('Also removes ' + c.wouldRetract + ' training sample(s) this meeting gave that profile, so the mistake stops reinforcing itself.');
    if (c.untraceable > 0) line(c.untraceable + ' older sample(s) carry no meeting provenance and cannot be removed.', 'sp-tert sp-small');
    if (c.proseStale) line('The summary still names the old speaker. It refers to people by first name, so it is left alone rather than risk rewriting a sentence about someone else.', 'sp-tert sp-small');
    if (c.similarity != null) line('Voice similarity ' + two(c.similarity), 'sp-mono-s sp-tert');
    if (needsForce(c)) {
      var person = c.assignment.person;
      line(R.forceArmed
        ? 'Add ' + c.assignment.samples + ' voice sample' + s(c.assignment.samples) + ' to ' + person + '’s profile even though the checks above flagged this voice? Only do this if you know it is ' + person + '.'
        : 'The server holds these samples back. ' + person + '’s profile also drives who is recognised in future meetings, so a voice that is not theirs would stay in it until you remove it.');
    }
    out += '<div class="sp-inline">';
    if (!c.refused) {
      if (needsForce(c)) {
        out += '<button type="button" class="cx-btn primary" data-sp="corr-rename-only"' + busy + '>Rename only</button>';
        out += R.forceArmed
          ? '<button type="button" class="cx-btn quiet" data-sp="corr-add-anyway"' + busy + '>Yes, add the samples</button><button type="button" class="sp-text" data-sp="corr-disarm">Back</button>'
          : '<button type="button" class="cx-btn quiet" data-sp="corr-arm"' + busy + '>Add anyway</button>';
      } else {
        out += '<button type="button" class="cx-btn primary" data-sp="corr-save"' + busy + '>Save</button>';
        if (addsSamples(c)) out += '<button type="button" class="cx-btn quiet" data-sp="corr-rename-only"' + busy + '>Rename only</button>';
      }
    } else if (c.forceable) out += '<button type="button" class="cx-btn primary" data-sp="corr-force"' + busy + '>Apply anyway</button>';
    out += '<button type="button" class="cx-btn quiet" data-sp="corr-cancel">' + (c.refused ? 'OK' : 'Cancel') + '</button>';
    if (c.refused && !c.forceable) out += '<button type="button" class="sp-text" data-sp="corr-reopen">Reopen review</button>';
    if (R.busy) out += spin();
    return out + '</div></div>';
  }
  function suggestBar(R) {
    if (!showsSuggest(R)) return '';
    var line = suggestLine(R);
    return '<div class="sp-sbar"><div class="sp-inline"><button type="button" class="cx-btn quiet" data-sp="suggest"' + (isRunning(R) || R.busy ? ' disabled' : '') + '>Suggest names</button>' +
      (isRunning(R) ? spin() : '') + '</div>' + (line ? '<p class="sp-muted sp-small">' + esc(line) + '</p>' : '') + '</div>';
  }
  function policyBlock(R) {
    var p = R.policy, rv = R.review;
    if (!rv || !rv.mutable) return '';
    var dis = p.busy || !p.revision;
    return '<div class="sp-policy"><div class="sp-inline"><span class="sp-strong">Voice identity</span>' +
      '<select class="field sp-policy-select" id="sp-policy" aria-label="Voice identity"' + (dis ? ' disabled' : '') + '>' +
      [['standard', 'Standard'], ['high-confidence', 'High-confidence only'], ['anonymous', 'Anonymous / video']].map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === p.mode ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>' +
      '<button type="button" class="cx-btn quiet" data-sp="policy-apply"' + (dis || (p.mode === p.saved && p.revision !== 'unreadable') ? ' disabled' : '') + '>' + (p.revision === 'unreadable' ? 'Repair settings' : 'Apply') + '</button>' +
      (p.busy ? spin() : '') + '</div><p class="sp-muted sp-small">Applies to new audio in this recording. Strict modes keep transcription, skip automatic profile training, and never assume the wearer is speaking. Existing names need a speaker correction.</p>' +
      (p.error ? '<p class="sp-err">' + esc(p.error) + '</p>' : '') +
      (!p.revision && !p.busy ? '<button type="button" class="sp-text" data-sp="policy-retry">Retry voice settings</button>' : '') + '</div>';
  }
  function reviewHeader(R) {
    var rv = R.review, lines = [];
    if (rv) {
      lines.push('<p class="sp-mono">' + esc(inventoryHeader(rv)) + '</p>');
      if (rv.assertedSegments != null && rv.segments > 0 && rv.attributed) {
        lines.push('<p class="sp-mono' + (rv.assertedSegments * 2 < rv.segments ? ' sp-orange' : '') + '">' + rv.assertedSegments + ' of ' + rv.segments + ' segments named</p>');
      }
      if (R.copyNote) lines.push('<p class="sp-mono sp-green">' + esc(R.copyNote) + '</p>');
      if (rv.summary) { if (rv.summary.unresolvedNote) lines.push('<p class="sp-mono sp-amber-t">' + esc(rv.summary.unresolvedNote) + '</p>'); }
      else if (!rv.intervalReadOnly && rv.unnamed > 0) {
        lines.push('<p class="sp-mono sp-amber-t">' + esc(rv.layout ? rv.unnamed + ' voice label' + (rv.unnamed === 1 ? ' has' : 's have') + ' no name yet'
          : rv.unnamed === 1 ? '1 voice still needs a name' : rv.unnamed + ' voices still need names') + '</p>');
      }
      if (rv.coverage != null && rv.attributed) {
        lines.push('<p class="sp-mono' + (rv.coverage < 0.6 ? ' sp-orange' : '') + '">' + esc(rv.coverage < 0.6
          ? 'only ' + Math.round(rv.coverage * 100) + '% of the voice identified, shares unreliable'
          : 'talk time from ' + (rv.speakingTimeSource === 'words' ? 'word timings' : 'chunk estimates')) + '</p>');
      }
    }
    var acts = '';
    if (rv && rv.recordId) acts += '<button type="button" class="cx-btn quiet" data-sp="open-meeting" title="Open this meeting’s transcript, summary and files">' + icon('meetings') + 'Open meeting</button>';
    if (R.content && R.content.clipboardSummary) {
      acts += '<button type="button" class="cx-btn quiet" data-sp="copy-summary" title="Copy the meeting without the transcript">Summary</button>' +
        '<button type="button" class="cx-btn quiet" data-sp="copy-full" title="Copy the meeting including the full transcript">Full (' + Math.max(1, Math.floor(R.content.fullChars / 1024)) + ' KB)</button>';
    }
    var next = S.meetings ? nextUnnamed(R.sid) : null;
    acts += '<button type="button" class="cx-btn quiet" data-sp="next-unnamed"' + (next ? '' : ' disabled') + ' title="' +
      (next ? 'Open the next meeting that still needs names (⌘])' : 'No other meetings still need names') + '">Next to name' + icon('chev') + '</button>';
    return '<div class="cx-detail-head sp-rhead"><div class="sp-rtitle"><h2 class="cx-detail-title sp-display">' + esc(rv ? rv.title : 'Speaker review') + '</h2>' + lines.join('') + '</div>' +
      '<div class="cx-actions sp-racts">' + acts + '</div></div>';
  }
  function writeUp(R) {
    var c = R.content;
    if (c && c.sections.length) {
      var stale = c.removed.filter(function (r) { return r.proseStale; }).map(function (r) { return '"' + r.label + '"'; });
      return '<div class="sp-writeup">' + (stale.length ? '<p class="sp-mono sp-orange">' + esc('You removed ' + stale.join(', ') + ' from this meeting. The write-up below was written before that and still uses the name.') + '</p>' : '') +
        c.sections.map(function (sec) { return '<div class="sp-sec"><div class="sp-caps">' + esc(sec[0].toUpperCase()) + '</div><div class="sp-sec-body">' + esc(panelPreview(sec[1])) + '</div></div>'; }).join('') + '</div>';
    }
    if (R.contentUnavailable) {
      return '<p class="sp-muted sp-writeup-note">' + esc(R.contentUnavailable === 'route_absent' ? 'The meeting write-up needs glasses-server 6.21.28 or newer. Use Update Server in Settings.'
        : R.contentUnavailable === 'error' ? 'The meeting write-up could not be loaded.' : R.contentUnavailable) + '</p>';
    }
    if (c && !c.scribeAvailable) return '<p class="sp-muted sp-writeup-note">No write-up saved for this meeting yet.</p>';
    return '';
  }
  function reviewBody(R) {
    var rv = R.review;
    if (!rv) {
      if (R.loadError) return '<div class="sp-empty"><p>' + esc(R.loadError) + '</p><button type="button" class="cx-btn quiet" data-sp="retry">Try again</button></div>';
      return '<p class="cx-note sp-loading">' + spin() + 'Reading the transcript…</p>';
    }
    var out = '';
    if (rv.timeline.length) out += ribbon(R);
    else if (rv.attributed) out += '<p class="sp-muted sp-small sp-pad">The speaking timeline needs glasses-server 6.21.18 or newer. Use Update Server in Settings.</p>';
    if (!rv.attributed) {
      out += '<div class="sp-pad"><b>No one was identified in this recording</b><p class="sp-muted">' + esc(rv.isMac ? MAC_UNATTRIBUTED
        : 'The audio was recovered after the session ended, so no voice matching ran while it played. The lines below are all that is left to go on.') + '</p></div>';
    }
    out += suggestBar(R);
    R.zoneDrawn = false;
    var list = '';
    if (rv.layout) {
      list += rv.layout.rows.map(function (row) { return row.merged ? mergedRow(R, row.merged) : voiceRow(R, row.voice, rv.layout.seconds[row.voice.label]); }).join('');
      if (rv.layout.short.length) {
        // A card about a short voice opens the fold, or it would sit hidden inside it.
        var holds = R.anchor != null && rv.layout.short.some(function (v) { return v.label === R.anchor; }) && !!(R.error || R.pending || R.groupPlan || R.groupProgress || R.groupOutcome);
        if (holds) R.shortOpen = true;
        list += '<details class="sp-fold sp-short"' + (R.shortOpen ? ' open' : '') + ' data-fold="short"><summary>Short voices (' + rv.layout.short.length + ')</summary>' +
          rv.layout.short.map(function (v) { return voiceRow(R, v, rv.layout.seconds[v.label]); }).join('') + '</details>';
      }
    } else list += rv.ordered.map(function (v) { return voiceRow(R, v, null); }).join('');
    // A row that is not on screen (a collapsed group, a label a refetch renamed) still gets its card, above the list.
    out += R.zoneDrawn ? '' : actionZone(R, null, true);
    out += '<div class="sp-voices">' + list + '</div>';
    return out + writeUp(R);
  }
  function renderReview(R) {
    return '<div class="cx sp-review" data-tint="speakers">' + reviewHeader(R) + policyBlock(R) +
      (R.loading && R.review ? '<p class="cx-note sp-loading">' + spin() + 'Reading the transcript…</p>' : '') + reviewBody(R) + '</div>';
  }

  // ── render dispatch ────────────────────────────────────
  var expiryTimer = null;
  function render() {
    if (W.parseRoute().pane !== 'speakers') return;
    var rt = route();
    var active = document.activeElement;
    var fid = active && pane.contains(active) && active.id ? active.id : null, sel = null;
    if (fid && typeof active.selectionStart === 'number') { try { sel = [active.selectionStart, active.selectionEnd]; } catch (_e) { sel = null; } }
    var html;
    if (rt.review) html = S.R ? renderReview(S.R) : '';
    else if (rt.voice) html = voiceDetail(rt.voice);
    else {
      if (rt.view === 'samples' && !S.H) S.H = newHeld();
      html = '<div class="cx" data-tint="speakers">' + hero(rt.view) + toolbar(rt.view) +
        (rt.view === 'meetings' ? meetingsBody() : rt.view === 'samples' ? samplesBody() : voicesBody()) + '</div>';
    }
    pane.innerHTML = html;
    if (fid) {
      var el = $(fid);
      if (el) { try { el.focus({ preventScroll: true }); if (sel) el.setSelectionRange(sel[0], sel[1]); } catch (_e) {} }
    }
    var wantExpiry = !rt.review && !rt.voice && rt.view === 'samples' && S.H && S.H.sheet === 'preview' && S.H.preview;
    if (wantExpiry && !expiryTimer) expiryTimer = setInterval(tickExpiry, 1000);
    if (!wantExpiry && expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; }
  }
  function tickExpiry() {
    var H = S.H, el = $('sp-expiry');
    if (!H || !H.preview || !el) return;
    el.textContent = expiryLine(H.preview);
    var btn = pane.querySelector('[data-sp="sheet-apply"]');
    if (btn) btn.disabled = !canApply(H);
  }
  // The ribbon readout updates in place: a full render per pointer move would be needless work on a phone.
  function paintRibbon() {
    var R = S.R, read = $('sp-tl-read'), bar = $('sp-bar');
    if (!R || !R.review || !read || !bar) return;
    var rv = R.review, span = R.hovered != null ? rv.timeline[R.hovered] : null;
    read.innerHTML = span ? '<span class="sp-mono-s">' + stamp(span.startMs) + '</span> <b>' + esc(displayNameOf(rv, span.speaker)) + '</b> <span class="sp-mono-s">' +
      span.segments + ' seg · ' + Math.max(1, Math.floor((span.endMs - span.startMs) / 1000)) + 's</span>'
      : '<span class="sp-muted sp-small">' + (hoverless() ? 'Tap the bar to see who is speaking' : 'Hover the bar to see who is speaking') + '</span>';
    Array.prototype.forEach.call(bar.children, function (c, i) { c.classList.toggle('dim', R.hoveredCol != null && i !== R.hoveredCol); });
  }
  function pointAt(e) {
    var R = S.R, bar = $('sp-bar');
    if (!R || !R.review || !bar || !R.cols) return;
    var rect = bar.getBoundingClientRect();
    var i = Math.max(0, Math.min(R.cols.length - 1, Math.floor((e.clientX - rect.left) / Math.max(1, rect.width) * R.cols.length)));
    var at = R.cols[i].startMs, tl = R.review.timeline, idx = null;
    for (var k = 0; k < tl.length; k++) { if (tl[k].startMs <= at) idx = k; else break; }
    R.hoveredCol = i; R.hovered = idx == null ? (tl.length ? 0 : null) : idx;
    paintRibbon();
  }

  // ── events ─────────────────────────────────────────────
  function heldRefs(key) {
    var H = S.H;
    if (!H) return [];
    if (key.indexOf('loose:') === 0) return H.loose.filter(function (x) { return 'loose:' + x.id === key; });
    if (key.indexOf('ext:') === 0) {
      var x = H.extSessions.filter(function (e) { return 'ext:' + e.sessionId === key; })[0];
      return x ? x.chunkIndices.map(function (c) { return { sessionId: x.sessionId, chunkIndex: c }; }) : [];
    }
    var g = H.groups.filter(function (y) { return y.id === key; })[0];
    return g ? g.playOrder : [];
  }
  function heldMembers(key) {
    var H = S.H;
    if (key.indexOf('loose:') === 0) return heldRefs(key);
    var g = H.groups.filter(function (y) { return y.id === key; })[0];
    return g ? g.members : [];
  }
  function heldSuggestion(key) {
    var H = S.H;
    if (key.indexOf('loose:') === 0) { var l = heldRefs(key)[0]; return l && l.suggestion ? l.suggestion.name : null; }
    var g = H.groups.filter(function (y) { return y.id === key; })[0];
    return g ? g.suggestionName : null;
  }
  function findRow(R, id) {
    var rows = (R.review && R.review.layout) ? R.review.layout.rows : [];
    for (var i = 0; i < rows.length; i++) if (rows[i].merged && rows[i].merged.id === id) return rows[i].merged;
    return null;
  }
  function openMeeting(R) {
    var rv = R.review;
    var row = (S.meetings || []).filter(function (m) { return m.sessionId === R.sid; })[0];
    var month = (row && row.month) || ((/^(\d{4}-\d{2})/.exec(rv.filename) || [])[1]) || '';
    var domain = (row && row.domain) || rv.domain, file = (row && row.filename) || rv.filename;
    if (domain && month && file) W.go('meetings', [domain, month, file]);
    else W.toast('This meeting has no saved file to open.');
  }
  function scrollZone() {
    setTimeout(function () { var z = $('sp-zone'); if (z && z.scrollIntoView) z.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30);
  }
  pane.addEventListener('click', function (e) {
    var t = e.target.closest('[data-sp]');
    if (!t || !pane.contains(t)) return;
    var act = t.getAttribute('data-sp'), R = S.R, H = S.H, rt = route();
    switch (act) {
      case 'view': {
        var v = t.getAttribute('data-view');
        stopPlayback(); A.note = null;
        if (H) { H.naming = null; H.confirmDiscard = null; H.result = ''; }
        S.view = v;
        if (W.parseRoute().args.length) W.go('speakers'); else render();
        if (v === 'meetings') loadMeetings(); else if (v === 'samples') { if (!S.H) S.H = newHeld(); loadHeld(); } else loadDirectory(false);
        syncPeek();
        return;
      }
      case 'refresh':
        if (rt.view === 'meetings') loadMeetings(); else if (rt.view === 'samples') loadHeld(); else loadDirectory(true);
        return;
      case 'open-review': W.go('speakers', ['review', t.getAttribute('data-sid')]); return;
      case 'open-voice': W.go('speakers', ['voice', t.getAttribute('data-name')]); return;
      case 'open-appearance': W.go('speakers', ['voice', rt.voice, 'review', t.getAttribute('data-sid')]); return;
      case 'clear-search': S.voiceSearch = ''; render(); return;
      case 'dir-retry': loadDirectory(true); return;
      // Samples
      case 'held-play': case 'held-prev': case 'held-next': {
        var key = t.getAttribute('data-key'), refs = heldRefs(key);
        if (!refs.length) return;
        var cur = Math.min(Math.max(H.cursor[key] || 0, 0), refs.length - 1);
        if (act === 'held-play') { var ref = refs[cur]; play('held:' + ref.sessionId + '#' + ref.chunkIndex, t.getAttribute('data-voice'), extSampleUrl(ref), 'That sample is no longer held.'); return; }
        stopPlayback();
        H.cursor[key] = (cur + (act === 'held-next' ? 1 : -1) + refs.length) % refs.length;
        render(); return;
      }
      case 'held-add': { var k = t.getAttribute('data-key'); nameHeld(heldMembers(k), heldSuggestion(k)); return; }
      case 'held-name': H.naming = t.getAttribute('data-key'); H.typed = ''; H.confirmDiscard = null; render(); var inp = $('sp-held-input'); if (inp) inp.focus(); return;
      case 'held-cancel': H.naming = null; H.typed = ''; render(); return;
      case 'held-preview': nameHeld(heldMembers(H.naming), H.typed).then(function () { if (!H.naming) H.typed = ''; }); return;
      case 'held-fill': H.typed = t.getAttribute('data-name'); render(); return;
      case 'held-discard': H.confirmDiscard = t.getAttribute('data-key'); H.naming = null; render(); return;
      case 'held-discard-no': H.confirmDiscard = null; render(); return;
      case 'held-discard-yes': { var dk = t.getAttribute('data-key'); H.confirmDiscard = null; discardHeld(heldMembers(dk)); return; }
      case 'held-discard-all': H.confirmDiscard = 'loose-all'; render(); return;
      case 'held-discard-all-yes': H.confirmDiscard = null; discardHeld(H.loose.slice()); return;
      case 'held-more': H.shown += ROW_PAGE; render(); return;
      case 'held-history': H.sheet = 'history'; render(); return;
      case 'held-result': H.sheet = 'result'; render(); return;
      case 'held-undo-ask': H.confirmUndo = t.getAttribute('data-handle'); render(); window.scrollTo(0, 0); return;
      case 'held-undo-no': H.confirmUndo = null; render(); return;
      case 'held-undo-yes': undoHeld(H.confirmUndo); return;
      case 'held-resume': { var b = H.batches.filter(function (x) { return x.batchId === t.getAttribute('data-batch'); })[0]; if (b) resumeHeld(b); return; }
      case 'sheet-cancel': cancelPreview(); render(); return;
      case 'sheet-close': H.sheet = null; render(); return;
      case 'sheet-apply': applyHeld(); return;
      case 'sheet-repreview': nameHeld(H.preview ? H.preview.members : H.members, H.revised); return;
      case 'naming-play': {
        var sid = t.getAttribute('data-sid'), ch = Number(t.getAttribute('data-chunk'));
        play(t.getAttribute('data-key'), 'held-naming-preview', sidPath(sid) + '/audio/' + ch, 'Audio expired, vectors only.'); return;
      }
    }
    if (!R || !R.review) { if (act === 'retry') retryReview(); return; }
    switch (act) {
      case 'retry': retryReview(); return;
      case 'dismiss': R.error = ''; render(); return;
      case 'dismiss-outcome': R.groupOutcome = ''; render(); return;
      case 'legend': {
        var sp = t.getAttribute('data-speaker'), tl = R.review.timeline;
        for (var i = 0; i < tl.length; i++) if (tl[i].speaker === sp) { R.hovered = i; break; }
        R.hoveredCol = null; paintRibbon(); return;
      }
      case 'phrase': {
        var label = t.getAttribute('data-label'), chunk = Number(t.getAttribute('data-chunk'));
        play(label + '#' + chunk, label, sidPath(R.sid) + '/audio/' + chunk, 'That segment’s audio is no longer held.'); return;
      }
      case 'naming-open': R.naming = t.getAttribute('data-label'); R.confirmMenu = null; render(); var ni = $('sp-name-input'); if (ni) ni.focus(); return;
      case 'naming-cancel': if (R.naming) R.typed[R.naming] = ''; R.naming = null; render(); return;
      case 'scope': R.scope = t.getAttribute('data-scope'); render(); return;
      case 'rename-pick': case 'rename-new': {
        var lb = t.getAttribute('data-label'), v = R.review.byLabel[lb], to = t.getAttribute('data-name');
        if (!v) return;
        previewRename(lb, to, R.scope, v.isNameAssignment, act === 'rename-pick' && R.review.isMac && isVoiceLabel(lb));
        scrollZone(); return;
      }
      case 'group-pick': case 'group-new': {
        var row = findRow(R, t.getAttribute('data-id'));
        if (row) { previewGroupName(row, t.getAttribute('data-name'), act === 'group-pick'); scrollZone(); }
        return;
      }
      case 'group-save': if (R.groupPlan) confirmGroupName(R.groupPlan); return;
      case 'group-cancel': R.groupPlan = null; render(); return;
      case 'toggle-row': { var id = t.getAttribute('data-id'); R.expanded[id] = !R.expanded[id]; render(); return; }
      case 'confirm-menu': R.confirmMenu = t.getAttribute('data-label'); render(); return;
      case 'confirm-voice': R.confirmMenu = null; confirmVoice(t.getAttribute('data-label')); return;
      case 'deattribute': previewDeattribution(t.getAttribute('data-label')); scrollZone(); return;
      case 'use-suggestion': {
        var rows = t.getAttribute('data-rows').split('|'), sg = suggestionsFor(R, rows).filter(function (x) { return x.id === t.getAttribute('data-id'); })[0];
        if (sg) { useSuggestion(sg, rows); scrollZone(); }
        return;
      }
      case 'suggest': startSuggestions(); return;
      case 'corr-save': confirmCorrection(R.pending, {}); return;
      case 'corr-rename-only': confirmCorrection(R.pending, { renameOnly: true }); return;
      case 'corr-arm': if (R.pending && needsForce(R.pending)) { R.forceArmed = true; render(); } return;
      case 'corr-disarm': R.forceArmed = false; render(); return;
      case 'corr-add-anyway': confirmCorrection(R.pending, { addAnyway: true }); return;
      case 'corr-force': confirmCorrection(R.pending, { force: true }); return;
      case 'corr-cancel': R.pending = null; R.forceArmed = false; render(); return;
      case 'corr-reopen': R.pending = null; retryReview(); return;
      case 'policy-apply': savePolicy(R); return;
      case 'policy-retry': loadPolicy(R); render(); return;
      case 'open-meeting': openMeeting(R); return;
      case 'copy-summary': case 'copy-full': {
        var full = act === 'copy-full', c = R.content;
        var text = full ? c.clipboardFull : c.clipboardSummary;
        if (!text) { R.copyNote = 'Nothing to copy'; render(); return; }
        W.copyText(text).then(function () {
          var kb = Math.max(1, Math.floor((full ? c.fullChars : c.summaryChars) / 1024));
          R.copyNote = full ? 'Copied full meeting (' + kb + ' KB)' : 'Copied summary (' + kb + ' KB)'; render();
        }, function (err) { W.toast(err.message); });
        return;
      }
      case 'next-unnamed': {
        var nx = S.meetings ? nextUnnamed(R.sid) : null;
        if (nx) W.go('speakers', ['review', nx.sessionId]);
        return;
      }
    }
  });
  pane.addEventListener('input', function (e) {
    var id = e.target.id, R = S.R, H = S.H;
    if (id === 'sp-name-input' && R) {
      var label = e.target.getAttribute('data-label');
      R.typed[label] = e.target.value;
      var box = $('sp-opts');
      if (box) { var row = findRow(R, label); box.innerHTML = row ? groupOptions(R, row) : (R.review.byLabel[label] ? namingOptions(R, R.review.byLabel[label]) : ''); }
    } else if (id === 'sp-held-input' && H) {
      H.typed = e.target.value;
      var hint = $('sp-held-hint'); if (hint) hint.innerHTML = nameHint(H.typed);
      var pb = pane.querySelector('[data-sp="held-preview"]');
      if (pb) pb.disabled = H.busy || !H.speakerModel || !H.namingAvailable || H.typed.trim().length < 2;
    } else if (id === 'sp-revised' && H) {
      H.revised = e.target.value;
      var rb = pane.querySelector('[data-sp="sheet-repreview"]'); if (rb) rb.disabled = H.busy || H.revised.trim().length < 2;
    } else if (id === 'sp-vq') {
      S.voiceSearch = e.target.value;
      clearTimeout(pane._vq); pane._vq = setTimeout(render, 120);
    }
  });
  pane.addEventListener('change', function (e) {
    var id = e.target.id, H = S.H, R = S.R;
    if (id === 'sp-hide') { P.hideReviewed = e.target.checked; savePrefs(); render(); }
    else if (id === 'sp-msort') { P.sort = e.target.value; savePrefs(); render(); }
    else if (id === 'sp-vsort') { S.voiceSort = e.target.value; render(); }
    else if (id === 'sp-policy' && R) { R.policy.mode = e.target.value; render(); }
    else if (id === 'sp-owner-ack' && H) { H.ownerAck = e.target.checked; render(); }
    else if (id === 'sp-listened' && H) { H.listened = e.target.checked; render(); }
  });
  pane.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var H = S.H;
    if (e.target.id === 'sp-held-input' && H && H.typed.trim().length >= 2 && !H.busy) { e.preventDefault(); nameHeld(heldMembers(H.naming), H.typed); }
    else if (e.target.id === 'sp-revised' && H && H.revised.trim().length >= 2 && !H.busy) { e.preventDefault(); nameHeld(H.preview ? H.preview.members : H.members, H.revised); }
  });
  pane.addEventListener('toggle', function (e) { if (S.R && e.target.getAttribute && e.target.getAttribute('data-fold') === 'short') S.R.shortOpen = e.target.open; }, true);
  pane.addEventListener('pointermove', function (e) { if (e.target.closest && e.target.closest('#sp-bar') && e.pointerType === 'mouse') pointAt(e); });
  pane.addEventListener('pointerdown', function (e) { if (e.target.closest && e.target.closest('#sp-bar')) pointAt(e); });
  pane.addEventListener('pointerout', function (e) {
    var R = S.R;
    if (!R || e.pointerType !== 'mouse' || !e.target.closest || !e.target.closest('#sp-bar')) return;
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#sp-bar')) return;
    R.hovered = null; R.hoveredCol = null; paintRibbon();
  });
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.key !== ']' || !S.R || W.parseRoute().pane !== 'speakers') return;
    var nx = S.meetings ? nextUnnamed(S.R.sid) : null;
    if (nx) { e.preventDefault(); W.go('speakers', ['review', nx.sessionId]); }
  });

  // A deep link rewritten to #/speakers was routed as a reader; put back the root chrome route() would have drawn.
  function rootChrome() {
    var back = $('topbar-back'), sw = $('section-btn');
    if (back) back.classList.add('hidden');
    if (sw) sw.classList.remove('hidden');
    pane.classList.remove('reading');
  }

  // ── registration ───────────────────────────────────────
  W.registerPane('speakers', {
    load: function (args, ctx) {
      var a0 = (args || [])[0];
      if (a0 === 'meetings' || a0 === 'samples' || a0 === 'voices') {
        S.view = a0;
        try { history.replaceState(history.state, '', location.pathname + location.search + '#/speakers'); } catch (_e) {}
        rootChrome();
      }
      var rt = route(), changed = !!(ctx && ctx.changed);
      // A voice detail belongs to the directory; a review opened from anywhere else returns to Meetings to review.
      if (rt.voice) S.view = 'voices';
      else if (rt.review) S.view = 'meetings';
      if (S.R && !(rt.review === S.R.sid && (rt.voice || null) === S.R.parent)) closeReview();
      if (rt.review) {
        openReview(rt.review, rt.voice || null);
        if (!S.meetings && !S.meetingsLoading) loadMeetings();
        if (S.R && S.R.review) W.setCrumb(S.R.review.title);
        render();
      } else if (rt.voice) {
        if (!S.dir && !S.dirLoading) loadDirectory(false);
        render();
      } else if (rt.view === 'samples') {
        if (!S.H) S.H = newHeld();
        if (changed || S.H.state == null) loadHeld(); else render();
      } else if (rt.view === 'voices') {
        if (changed || !S.dir) loadDirectory(false); else render();
      } else {
        if (changed || !S.meetings) loadMeetings(); else render();
      }
      syncPeek();
    },
    leave: function () {
      closeReview(); stopPlayback();
      if (S.peekTimer) { clearInterval(S.peekTimer); S.peekTimer = null; }
      if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; }
    },
    // Back unwinds one step: a review opened from a voice returns to that voice, a voice to the directory.
    // A voice returns to the directory and a review to its list: both are #/speakers, which shows the selected view.
    up: function (args) {
      if (args[0] === 'voice' && args[2] === 'review') return ['voice', args[1]];
      return null;
    }
  });
})();
