// Needs you's pill and its list agree (#C366, the owner in #T976 on live 0aac0d2: the pill read 1 over "Nothing to do
// now."). Reproduced on today's board: the owner answers the one ask under Needs you; the live update redraws all while
// the reply is under 2.5 s old (SENT_MS), so the ask still counts as his; 2.6 s later the reply handler's timer redrew
// Needs you alone, and the pills (and Waiting on Manager) kept the old numbers. The list and its count now come from
// one function, and that timer redraws Needs you, Waiting on Manager and the pills together.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now();
const msg = (thread, from, text, at) => ({ id: `m${at}${from}`, thread, from, text, at });
function board(waiting, messages = []) {
  const b = loadNames(["renderAll", "renderWaiting", "settleRedraw", "youItems", "tabCounts"]);
  Object.assign(b.state, { waiting, messages, threads: [], initRaw: [], ideas: [], todo: [] });
  return b;
}
const later = (id) => ({ id, kind: "later", text: "Later " + id, since: T - 9e5 });
const pill = (b, k) => Number((b.els.ttabs.innerHTML.match(new RegExp(`id="tab-${k}"[^>]*>[^<]*<span[^>]*>(\\d+)`)) || [])[1]);
const rows = (b) => (b.els.waiting.innerHTML.match(/<details class="w-item"/g) || []).length;

test("the owner's case: only Later asks wait on him, so Needs you reads 0 and says nothing needs him", () => {
  const b = board([later("l1"), later("l2"), later("l3"), later("l4")]);
  b.renderAll();
  assert.equal(pill(b, "you"), 0);
  assert.equal(pill(b, "later"), 4);
  assert.equal(b.els.waiting.innerHTML, '<div class="empty">Nothing needs you.</div>');
});

test("the pill counts exactly the rows the list draws: asks on him and threads Manager answered", () => {
  const b = board([later("l1"), { id: "d1", kind: "decision", text: "Go?", options: [{ key: "A", label: "Go" }], since: T - 5e5 }],
    [msg("t-a", "Owner", "Question", T - 4e5), msg("t-a", "Manager", "Answer", T - 3e5)]);
  b.renderAll();
  const it = b.youItems(T, "");
  assert.equal(JSON.stringify([it.asks.map((w) => w.id), it.answered]), '[["d1"],["t-a"]]');
  assert.equal(pill(b, "you"), 2);
  assert.equal(rows(b), 2);
  assert.equal(b.tabCounts(T, "").you, it.asks.length + it.answered.length);
});

test("2.6 s after he answers, Needs you, Waiting on Manager and the pills move together", () => {
  const ask = { id: "d1", kind: "decision", text: "Go for #C364?", options: [{ key: "A", label: "Go" }], since: T - 6e5 };
  const b = board([later("l1"), ask]);
  ask.response = { status: "A", at: T };
  b.renderAll();
  assert.equal(pill(b, "you"), 1, "under SENT_MS: still his");
  const real = Date.now;
  Date.now = () => real() + 2600;
  try { b.settleRedraw(); } finally { Date.now = real; }
  assert.equal(pill(b, "you"), 0, "the pill follows the list");
  assert.equal(pill(b, "lead"), 1, "and the ask shows under Waiting on Manager");
  assert.match(b.els.threads.innerHTML, /Go for #C364/);
  assert.equal(b.els.waiting.innerHTML, '<div class="empty">Nothing needs you.</div>');
  assert.equal((page.match(/setTimeout\(settleRedraw,2600\)/g) || []).length, 2, "both reply paths");
  assert.doesNotMatch(page, /setTimeout\(renderWaiting,/);
});
