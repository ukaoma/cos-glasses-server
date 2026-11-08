/* COS Control Web: what counts as "Needs review" in Memories. The one predicate (Miles 2026-11-08: "We
   should only tag memories that need actual review with that status").

   Loaded by index.html before app.js, so the Memories pane reads it as window.COSMemoryReview, and imported by the
   server (server/lib/learning-needs-you.ts) for the count it hands Today, the rail story and the To review tab. The
   producer is MU's `learning_events.py needs-you` (review_state there); the case table REVIEW_CASES in
   memory-review.test.ts mirrors tests/test_memory_review_state.py in MU, case for case. Change both together.

   An item needs review only when it holds a decision only the owner can make, with a real next step:
     rule_ready     a suggested rule AT or OVER its promotion bar (0.8): approve, edit or dismiss. Below the bar it
                    cannot be promoted, so Dismiss is the only action: it is Learning, shown with its confidence and
                    never counted, until its confidence reaches the bar. `low_confidence` is the older producer's name
                    for the same suggestion and is judged by its confidence the same way.
     attribution    a decision that reports what a named person said, with no attribution: whose words were they.
     scope          a decision or correction with no domain, so recall cannot route it.
     contradiction  two memories that disagree (not produced yet).
     candidate      a governed memory awaiting acceptance, or a quarantined one awaiting release or delete.
     prune_ready    a memory the nightly retention pass would quarantine; it waits for Accept or Quarantine.
   A decision of accepted, dismissed or pruned moves an item to history. Any gate this file does not name is Learning,
   never counted. */
(function (root) {
  'use strict';
  // The bar is the producer's: learning_events.py RULE_PROMOTION_BAR, carried as `bar` on the needs-you block and on
  // each rule item. This copy is only the fallback for a block that does not carry one (an older producer); the parity
  // test in memory-review.test.ts reads the Python constant and fails if the two ever differ.
  var RULE_BAR = 0.8;
  var RULE_GATES = { rule_ready: 1, low_confidence: 1 };
  var DECISION_GATES = { attribution: 1, scope: 1, contradiction: 1, candidate: 1, prune_ready: 1 };
  var CLOSING = { accepted: 1, dismissed: 1, pruned: 1 };
  var NEEDS = 'needs_review', LEARNING = 'learning', HISTORY = 'history';
  function own(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** needs_review, learning or history for one item, from its gate, confidence and latest decision. */
  function reviewState(gate, confidence, decision, bar) {
    if (own(CLOSING, decision)) return HISTORY;
    if (own(RULE_GATES, gate)) return isNum(confidence) && confidence >= (isNum(bar) ? bar : RULE_BAR) ? NEEDS : LEARNING;
    if (own(DECISION_GATES, gate)) return NEEDS;
    return LEARNING;
  }
  /** The bar a block was judged with: its own `bar`, else the fallback. */
  function barOf(block) { return block && typeof block === 'object' && isNum(block.bar) ? block.bar : RULE_BAR; }
  /** The same, for a needs-you item; `decision` (a decision made on this page) wins over one on the item. The item's own
   *  `bar` wins, then `blockBar` (the block it came in), then the fallback. */
  function itemState(item, decision, blockBar) {
    if (!item || typeof item !== 'object') return LEARNING;
    return reviewState(item.gate, item.confidence, decision || item.decision, isNum(item.bar) ? item.bar : blockBar);
  }
  function needsReview(item, decision, blockBar) { return itemState(item, decision, blockBar) === NEEDS; }

  /** A needs-you block whose items are only what needs review. A below-bar suggestion from an older producer moves to
   *  `learning` and leaves `count`; the count keeps every needs-review item past the shown cap. Never mutates. */
  function normalizeBlock(block) {
    if (!block || typeof block !== 'object' || !Array.isArray(block.items)) return block || null;
    var keep = [], moved = [], bar = barOf(block);
    block.items.forEach(function (it) { (needsReview(it, null, bar) ? keep : moved).push(it); });
    var out = {};
    Object.keys(block).forEach(function (k) { out[k] = block[k]; });
    out.items = keep;
    if (isNum(block.count)) out.count = Math.max(keep.length, block.count - moved.length);
    if (moved.length && block.gates && typeof block.gates === 'object') {
      var gates = {};
      Object.keys(block.gates).forEach(function (g) { gates[g] = block.gates[g]; });
      moved.forEach(function (it) { var g = it && it.gate; if (own(gates, g) && isNum(gates[g])) { gates[g] -= 1; if (gates[g] <= 0) delete gates[g]; } });
      out.gates = gates;
    }
    var learnt = moved.filter(function (it) { return itemState(it, null, bar) === LEARNING && it && typeof it === 'object' && own(RULE_GATES, it.gate); });
    if (learnt.length || Array.isArray(block.learning)) {
      out.learning = learnt.concat(Array.isArray(block.learning) ? block.learning : []);
      out.learning_count = (isNum(block.learning_count) ? block.learning_count : (Array.isArray(block.learning) ? block.learning.length : 0)) + learnt.length;
    }
    return out;
  }
  /** The shown items that still need review, leaving out any decided on this page (`decisions`: lesson_id to decision). */
  function openItems(block, decisions) {
    var d = decisions || {}, bar = barOf(block);
    return block && Array.isArray(block.items) ? block.items.filter(function (it) { return needsReview(it, it && d[it.lesson_id], bar); }) : [];
  }
  /** The count every surface shows (Today, the rail, the To review tab): open shown items, else count capped by limit. */
  function count(block, decisions) {
    if (!block || typeof block !== 'object') return null;
    if (Array.isArray(block.items)) return openItems(block, decisions).length;
    if (isNum(block.count)) return isNum(block.limit) ? Math.min(block.count, block.limit) : block.count;
    return null;
  }
  /** Every item that needs review, past the shown cap (the "of N" in "Next 7 of N"). */
  function total(block) {
    if (!block || typeof block !== 'object') return null;
    if (isNum(block.count)) return block.count;
    return Array.isArray(block.items) ? openItems(block).length : null;
  }
  /** Below-bar suggestions to show under Learning, leaving out any decided on this page. */
  function learningItems(block, decisions) {
    var d = decisions || {}, bar = barOf(block);
    return block && Array.isArray(block.learning) ? block.learning.filter(function (it) { return itemState(it, it && d[it.lesson_id], bar) === LEARNING; }) : [];
  }

  root.COSMemoryReview = { RULE_BAR: RULE_BAR, barOf: barOf, NEEDS: NEEDS, LEARNING: LEARNING, HISTORY: HISTORY, reviewState: reviewState, itemState: itemState,
    needsReview: needsReview, normalizeBlock: normalizeBlock, openItems: openItems, count: count, total: total, learningItems: learningItems };
})(typeof window !== 'undefined' ? window : globalThis);
