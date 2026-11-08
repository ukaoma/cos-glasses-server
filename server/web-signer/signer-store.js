// Where the phone key lives (6.99.31, plan section 4.2): IndexedDB on the 3144 signer origin only.
// One record: the WebCrypto key pair (its private half was made with extractable false, so this page
// can use it but no script can read it out), the passkey credential id and the enrollment state.
// The big Control Web app on 3143 is another origin and cannot open this database.
// Classic script: it defines window.COSSignerStore.
(function (root) {
  'use strict'
  var DB = 'cos-web-key', STORE = 'keys', ID = 'phone-key'

  function open() {
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB, 1)
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE) }
      req.onsuccess = function () { resolve(req.result) }
      req.onerror = function () { reject(req.error || new Error('indexeddb_unavailable')) }
    })
  }
  function run(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode), out
        var req = fn(tx.objectStore(STORE))
        req.onsuccess = function () { out = req.result }
        tx.oncomplete = function () { db.close(); resolve(out) }
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error || new Error('indexeddb_failed')) }
      })
    })
  }

  root.COSSignerStore = {
    get: function () { return run('readonly', function (s) { return s.get(ID) }).then(function (r) { return r || null }) },
    put: function (record) {
      // Ask the browser not to evict the key under storage pressure. A refusal is not an error.
      try { if (root.navigator && root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist() } catch (_e) { /* best effort */ }
      return run('readwrite', function (s) { return s.put(record, ID) })
    },
    clear: function () { return run('readwrite', function (s) { return s.delete(ID) }) },
  }
})(typeof window !== 'undefined' ? window : globalThis)
