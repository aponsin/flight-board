// #C1233 (the owner: after he clicks an answer button he cannot tell whether it went). The thread folds at once, turns gray and shows small pulsing dots under its id until Manager has
// taken the message; it stays usable (a click opens it, a follow-up sends). The state is kept in markSending / applySending, run here on the page's own text with a stand-in list of rows.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const fragment = script.slice(script.indexOf("const folds=new Map();"), script.indexOf("// After a part is drawn again"));

const OWNER = "Reader";
function world({ live = true, seen = null, messages = [] } = {}) {
  const w = { rows: [], live, seen, messages };
  const mkRow = (dataId, { card = false, open = true } = {}) => {
    const summary = { dots: null, appended: 0, wtext: card ? null : { appendChild(h) { summary.appended++; summary.dots = h; h.remove = () => { summary.dots = null; }; } },
      querySelector(s) { return s === ".w-text" ? this.wtext : null; }, appendChild(h) { summary.appended++; summary.dots = h; h.remove = () => { summary.dots = null; }; } };
    const cls = new Set();
    const row = { dataset: { id: dataId }, open, cls, summary, classList: { contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
      querySelector(s) { return s === ":scope>summary" ? summary : s === ":scope>summary .sdots" ? summary.dots : null; } };
    w.rows.push(row); return row;
  };
  w.mkRow = mkRow;
  const ctx = { document: { querySelectorAll: () => w.rows, addEventListener() {}, createElement: () => ({ setAttribute() {}, className: "", appendChild() { this.kids = (this.kids || 0) + 1; } }) },
    liveOn: () => w.live, wakeSeen: () => w.seen, threadOf: () => w.messages, isT: (n) => typeof n === "number", OWNER, Map, Set, Date, Array, String };
  vm.createContext(ctx); vm.runInContext(fragment, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  return { w, run, mark: (id, at) => run(`markSending(${JSON.stringify(id)},${at})`), apply: (now) => run(`applySending(${now})`), folds: () => run("folds"), size: () => run("sending.size") };
}

test("a click folds the thread at once, grays it and shows the dots under its id, whichever row draws it", () => {
  const t = world(); const ask = t.w.mkRow("t1"), row = t.w.mkRow("th-t1"), card = t.w.mkRow("ith-t1", { card: true }), other = t.w.mkRow("th-t2");
  t.mark("t1", 1000);
  for (const r of [ask, row, card]) { assert.equal(r.open, false, "folded to its title bar"); assert.ok(r.cls.has("sending"), "gray"); assert.ok(r.summary.dots, "dots"); }
  assert.ok(!other.cls.has("sending") && !other.summary.dots && other.open === true, "another thread is left alone");
  assert.equal(t.folds().get("t1"), false, "the fold is remembered, so a redraw keeps it folded");
});

test("a redraw that makes a new row for the thread puts the state back; the dots are not drawn twice", () => {
  const t = world(); const row = t.w.mkRow("th-t1"); t.mark("t1", 1000); t.apply(2000); t.apply(3000);
  assert.ok(row.summary.dots); assert.equal(row.summary.appended, 1, "one dots element however many draws"); assert.equal(row.summary.dots.kids, 3, "three dots, built as elements (no new innerHTML sink)");
  const fresh = t.w.mkRow("th-t1"); t.w.rows.splice(t.w.rows.indexOf(row), 1);
  t.apply(4000); assert.ok(fresh.cls.has("sending") && fresh.summary.dots);
});

test("it stays usable: opening a gray thread is not undone by the next draw, and a follow-up starts the state again", () => {
  const t = world(); const row = t.w.mkRow("th-t1"); t.mark("t1", 1000);
  row.open = true; t.apply(5000);
  assert.equal(row.open, true, "the owner's own click is kept"); assert.ok(row.cls.has("sending"), "still gray while it is on its way");
  t.mark("t1", 6000); assert.equal(row.open, false, "a follow-up folds it again"); assert.equal(t.size(), 1);
});

test("a write that failed opens the thread again, whichever row draws it, so its Not saved line is in sight (Checker 2's F2); a clear without a failure leaves it folded", () => {
  const t = world(); const ask = t.w.mkRow("t1"), row = t.w.mkRow("th-t1"), card = t.w.mkRow("ith-t1", { card: true }), other = t.w.mkRow("th-t2", { open: false });
  t.mark("t1", 1000);
  t.run('clearSending("t1",true)');
  for (const r of [ask, row, card]) { assert.equal(r.open, true, "open again"); assert.ok(!r.cls.has("sending") && !r.summary.dots, "no longer gray"); }
  assert.equal(other.open, false, "another thread is left alone"); assert.equal(t.folds().get("t1"), true, "and a redraw keeps it open"); assert.equal(t.size(), 0);
  t.mark("t1", 2000); t.run('clearSending("t1")'); assert.equal(row.open, false, "without the failure flag it stays folded");
});

test("the dots go once Manager has taken the message: the delivered time reaches it, or Manager wrote after it", () => {
  let t = world({ live: true, seen: 999 }); let row = t.w.mkRow("th-t1"); t.mark("t1", 1000); t.apply(2000);
  assert.ok(row.cls.has("sending"), "delivered before it was sent is not delivered");
  t.w.seen = 1000; t.apply(2500); assert.ok(!row.cls.has("sending") && !row.summary.dots && t.size() === 0, "delivered at or after it: taken");
  t = world({ live: true, seen: null, messages: [{ from: OWNER, at: 1500 }] }); row = t.w.mkRow("th-t1"); t.mark("t1", 1000); t.apply(2000);
  assert.ok(row.cls.has("sending"), "his own newer word is not Manager's");
  t.w.messages.push({ from: "Manager", at: 1800 }); t.apply(2100); assert.ok(!row.cls.has("sending") && t.size() === 0, "Manager wrote after it: the thread has updated");
});

test("with the watch not live nothing is taken, and after ten minutes the state ends anyway", () => {
  const t = world({ live: false, seen: 10 ** 9 }); const row = t.w.mkRow("th-t1"); t.mark("t1", 1000);
  t.apply(1000 + 9 * 60e3); assert.ok(row.cls.has("sending"), "a stale delivered time does not count when the watch is not live");
  t.apply(1000 + 10 * 60e3 + 1); assert.ok(!row.cls.has("sending") && t.size() === 0, "the page never says it is sending for good");
});

test("every answer button marks the thread before anything is awaited and clears it when the write fails", () => {
  assert.match(script, /btn\.disabled=true;lastPing="";if\(key!=="new"\)markSending\(id\);const anchor=await prepAnchor\(btn\);/, "Send, and a decision option (through sendThread), not the new-thread form");
  assert.equal((script.match(/clearSending\(id,true\);restore\(\)/g) || []).length, 2, "both failures of a send clear it and open the thread");
  assert.match(script, /b\.disabled=true;markSending\(id\);try\{await applyWrites\(closeWrites\(id,Date\.now\(\)/, "Close");
  assert.match(script, /b\.disabled=true;markSending\(id\);try\{await applyWrites\(threadState\(id\)==="building"/, "Ack");
  assert.equal((script.match(/catch\(err\)\{b\.disabled=false;clearSending\(id,true\);/g) || []).length, 2, "Close and Ack clear it and open the thread when not saved");
  assert.match(script, /renderAgentPrs\(\);applySending\(\);liveWas/, "a whole redraw puts it back");
  assert.match(script, /restoreFolds\(el,open\);applySending\(\);back\(\)/, "so does a part's");
});

test("the look is made of the board's own tokens, in both themes, with the dots still when motion is reduced", () => {
  assert.match(css, /details\.sending>summary\{background:color-mix\(in srgb,var\(--line\) 35%,var\(--panel\)\)\}/, "the band keeps the board's tint");
  assert.match(css, /details\.sending>summary>\*\{filter:grayscale\(1\)\}/, "the grayscale is on the children, not on the band (Designer's F2)");
  assert.ok(!/details\.sending[^{]*\{[^}]*opacity/.test(css), "no opacity: faded text fails the contrast bar (Designer's F1)");
  assert.match(css, /details\.sending>summary,details\.sending>summary \*\{color:var\(--muted\)\}/);
  assert.match(css, /\.sdots i\{[^}]*background:var\(--muted\);animation:pulse 1\.2s/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.sdots i\{animation:none\}\}/);
  assert.ok(!/details\.sending[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/.test(css), "no color of its own");
});
