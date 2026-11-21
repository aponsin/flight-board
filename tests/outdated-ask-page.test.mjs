// #C1409 (the owner ran a Terminal ask's command after Manager had called it off: "your click should become outdated or
// something, in red so I don't miss it"). A called-off ask carries `outdated: {at, by, reason, replacedBy?}`. It stays listed
// where it was until the owner closes it, drawn Outdated in red with no Copy button, but it is no longer owed by him: it is
// in no tab count and does not light the red pill. Fictional board.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = Date.now();
const NAMES = ["renderAll", "renderWaiting", "askHtml", "youItems", "tabCounts", "laterAsks", "settled", "needsYou", "resolvedIds"];
const out = (more = {}) => ({ at: T - 6e4, by: "Manager", reason: "No longer needed: the fix shipped.", ...more });
const term = (id, more = {}) => ({ id, kind: "action", text: "Run the check", since: T - 9e5, steps: [{ text: "1. In Terminal run:", cmd: "npm run board -- --check" }], ...more });
const rearm = (id, more = {}) => ({ id, kind: "action", rearm: true, text: "Manager can't hear the board", since: T - 9e5, steps: ["1. In the Manager session, type: watch the flight board at the board's address"], ...more });
function board(waiting, messages = [], threads = []) {
  const b = loadNames(NAMES);
  Object.assign(b.state, { waiting, messages, threads, initRaw: [], ideas: [], todo: [] });
  return b;
}
const pill = (b, k) => Number((b.els.ttabs.innerHTML.match(new RegExp(`id="tab-${k}"[^>]*>[^<]*<span[^>]*>(\\d+)`)) || [])[1]);
const hot = (b) => /id="tab-you"[^>]*>[^<]*<span class="tcount hot"/.test(b.els.ttabs.innerHTML);

test("an outdated ask reads Outdated in a red badge, in place of its type chip", () => {
  const w = term("a1", { outdated: out() });
  const b = board([w]);
  const html = b.askHtml(w, new Set());
  assert.match(html, /<span class="kind outdated">Outdated<\/span>/);
  assert.doesNotMatch(html, /class="kind action"/);
  assert.match(html, /Called off by Manager: don't run these\./);
  assert.match(html, /class="w-item outdated"/);
});

test("the reason and a link to the replacement ask sit at the top of the card body", () => {
  const w = term("a1", { outdated: out({ replacedBy: 7 }) });
  const b = board([w], [{ id: "m1", thread: "t-7", from: "Manager", text: "x", at: T }], [{ id: "t-7", num: 7, title: "New check" }]);
  const html = b.askHtml(w, new Set());
  const body = html.split("</summary>")[1];
  assert.ok(body.startsWith('<div class="outdated-why">'), "first thing under the row");
  assert.match(body, /No longer needed: the fix shipped\. Replaced by <a href="#" class="t-ref" data-tref="t-7">#T7<\/a>\./);
  assert.ok(body.indexOf("outdated-why") < body.indexOf('<ol class="steps">'));
  const plain = board([term("a2", { outdated: out() })]).askHtml(term("a2", { outdated: out() }), new Set());
  assert.doesNotMatch(plain, /Replaced by/);
});

test("no Copy button and no data-copy anywhere in an outdated card; the commands stay, greyed by class", () => {
  const w = term("a1", { outdated: out() }), r = rearm("a3", { outdated: out() });
  const b = board([w, r]);
  for (const x of [w, r]) {
    const html = b.askHtml(x, new Set());
    assert.doesNotMatch(html, /data-copy/);
    assert.doesNotMatch(html, />Copy</);
    assert.match(html, /<div class="cmd"><code>/);
    assert.match(html, /class="w-item outdated"/);
  }
  assert.match(b.askHtml(w, new Set()), /<code>npm run board -- --check<\/code>/);
  assert.match(b.askHtml(r, new Set()), /<code>watch the flight board at the board&#39;s address<\/code>/, "the rearm line is drawn without its button");
});

test("still listed in Needs you (and in Later for a Later ask), drawn Outdated, but in no count and no red pill", () => {
  const nowAsk = term("a1", { outdated: out() });
  const laterAsk = { id: "l1", kind: "later", text: "Later thing", since: T - 9e5, steps: [{ text: "run", cmd: "do it" }], outdated: out() };
  const b = board([nowAsk, laterAsk]);
  b.renderAll();
  assert.equal(b.youItems(T, "").asks.map((w) => w.id).join(), "a1", "listed under Needs you");
  assert.equal(b.laterAsks(T, "").map((w) => w.id).join(), "l1", "listed under Later");
  assert.match(b.els.waiting.innerHTML, /<span class="kind outdated">Outdated<\/span>/);
  assert.equal(pill(b, "you"), 0);
  assert.equal(pill(b, "later"), 0);
  assert.equal(b.tabCounts(T, "").you, 0);
  assert.equal(b.tabCounts(T, "").later, 0);
  assert.equal(hot(b), false, "no red pill");
  assert.doesNotMatch(b.askHtml(nowAsk, new Set()), /waiting on you|t-badge/);
});

test("control: an ordinary ask beside an outdated one is counted and still has Copy", () => {
  const ok = term("c1"), lat = { id: "l2", kind: "later", text: "Later", since: T - 9e5 };
  const b = board([ok, term("a1", { outdated: out() }), lat, { ...lat, id: "l3", outdated: out() }]);
  b.renderAll();
  assert.equal(pill(b, "you"), 1);
  assert.equal(pill(b, "later"), 1);
  assert.equal(hot(b), true);
  const html = b.askHtml(ok, new Set());
  assert.match(html, /<button type="button" class="copy" data-copy="npm run board -- --check">Copy<\/button>/);
  assert.match(html, /<span class="kind action">/);
  assert.doesNotMatch(html, /outdated/);
  assert.match(b.askHtml(rearm("r1"), new Set()), /data-copy="watch the flight board at the board&#39;s address"/);
});

test("the owner's close is still there (Got it), and once closed it is settled, still drawn Outdated in red", () => {
  const w = term("a1", { outdated: out() });
  const b = board([w]);
  const open = b.askHtml(w, new Set());
  assert.match(open, /data-act="done" data-id="a1">Got it<\/button>/);
  assert.match(open, /data-act="help"/, "he can still answer it");
  assert.equal(b.needsYou(w, T), true);
  const closed = { ...w, response: { status: "done", at: T - 9e4 } };
  const c = board([closed], [{ id: "m1", thread: "a1", from: "Owner", text: "ok", at: T - 9e4 }, { id: "m2", thread: "a1", from: "Manager", text: "Called off", at: T - 8e4 }]);
  assert.equal(c.settled(closed), true);
  assert.equal(c.needsYou(closed, T), false);
  assert.equal(c.youItems(T, "").asks.length, 0, "gone from Needs you");
  assert.ok(c.resolvedIds(T).includes("a1"), "in Resolved");
  const html = c.askHtml(closed, new Set());
  assert.match(html, /<span class="kind outdated">Outdated<\/span>/);
  assert.doesNotMatch(html, /data-copy/);
});
