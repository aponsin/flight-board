// #C1233 (the owner: after he clicks an answer button he cannot tell whether it went). The thread folds at once, turns gray and shows small pulsing dots in place of its type label (#C1235) until Manager has
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
  const w = { rows: [], btns: [], live, seen, messages };
  // #C1241: a button the page marks by its data attributes (Ping, Check, Let's start, a context tile's refresh): a class and the dots as its child.
  w.mkBtn = (dataset) => {
    const cls = new Set(), btn = { dataset, cls, dots: null, adds: 0, classList: { contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
      querySelector(s) { return s === ":scope>.sdots" ? btn.dots : null; },
      appendChild(h) { btn.adds++; btn.dots = h; h.remove = () => { btn.dots = null; }; } };
    w.btns.push(btn); return btn;
  };
  const mkRow = (dataId, { card = false, open = true } = {}) => {
    // A summary lists its children: the type label (.kind) first, then the text; the dots go in before the label, never into the text (#C1235).
    const kind = card ? null : { cls: "kind" };
    const summary = { dots: null, appended: 0, kids: [kind, { cls: "w-text", under: 0 }].filter(Boolean),
      querySelector(s) { return s === ":scope>.kind" ? kind : null; },
      insertBefore(h, ref) { summary.appended++; summary.dots = h; summary.before = ref; summary.kids.splice(ref ? summary.kids.indexOf(ref) : summary.kids.length, 0, h); h.remove = () => { summary.dots = null; summary.kids.splice(summary.kids.indexOf(h), 1); }; } , get firstChild() { return summary.kids[0] || null; } };
    const cls = new Set();
    const row = { dataset: { id: dataId }, open, cls, summary, classList: { contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
      querySelector(s) { return s === ":scope>summary" ? summary : s === ":scope>summary .sdots" ? summary.dots : null; } };
    w.rows.push(row); return row;
  };
  w.mkRow = mkRow;
  const ctx = { document: { querySelectorAll: (sel) => (String(sel).startsWith("details") ? w.rows : w.btns), addEventListener() {}, createElement: () => ({ attrs: {}, children: [], className: "", textContent: "", setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); this.kids = (this.kids || 0) + 1; } }) },
    liveOn: () => w.live, wakeSeen: () => w.seen, threadOf: (id) => w.messages.filter((m) => !m.thread || m.thread === id), isT: (n) => typeof n === "number", OWNER, Map, Set, Date, Array, String };
  vm.createContext(ctx); vm.runInContext(fragment, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  return { w, run, mark: (id, at) => run(`markSending(${JSON.stringify(id)},${at})`), apply: (now) => run(`applySending(${now})`), folds: () => run("folds"), size: () => run("sending.size") };
}

test("a click folds the thread at once, grays it and shows the dots, whichever row draws it", () => {
  const t = world(); const ask = t.w.mkRow("t1"), row = t.w.mkRow("th-t1"), card = t.w.mkRow("ith-t1", { card: true }), other = t.w.mkRow("th-t2");
  t.mark("t1", 1000);
  for (const r of [ask, row, card]) { assert.equal(r.open, false, "folded to its title bar"); assert.ok(r.cls.has("sending"), "gray"); assert.ok(r.summary.dots, "dots"); }
  assert.ok(!other.cls.has("sending") && !other.summary.dots && other.open === true, "another thread is left alone");
  assert.equal(t.folds().get("t1"), false, "the fold is remembered, so a redraw keeps it folded");
});

test("a redraw that makes a new row for the thread puts the state back; the dots are not drawn twice", () => {
  const t = world(); const row = t.w.mkRow("th-t1"); t.mark("t1", 1000); t.apply(2000); t.apply(3000);
  assert.ok(row.summary.dots); assert.equal(row.summary.appended, 1, "one dots element however many draws"); assert.equal(row.summary.dots.children.filter((c) => c.attrs["aria-hidden"] === "true").length, 3, "three dots, built as elements (no new innerHTML sink)");
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
  assert.match(script, /btn\.disabled=true;lastPing="";markSending\(id\);const anchor=await prepAnchor\(btn\);/, "Send, and a decision option (through sendThread), and the new-thread form too (#C1241)");
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

// #C1235 (the owner, on #C1233: the dots sat under the thread's line): while it is sending they take the place of the type label (Answer / Decision / Question), nothing is added under the line, and the label is back once it is taken.
test("the dots stand in the type label's place: before it, nothing under the line, the label is hidden while sending and shown again after", () => {
  const t = world(); const row = t.w.mkRow("th-t1"), card = t.w.mkRow("ith-t1", { card: true });
  t.mark("t1", 1000);
  const [first, second] = row.summary.kids;
  assert.equal(first, row.summary.dots, "the dots are the first thing in the title bar, where the label was");
  assert.equal(second.cls, "kind", "the label stays in the page (CSS hides it), right after the dots");
  assert.equal(row.summary.kids.find((k) => k.cls === "w-text").under, 0, "nothing is added under the line (the text block is untouched)");
  assert.equal(card.summary.kids[0], card.summary.dots, "a row with no label gets the dots first as well");
  assert.match(css, /details\.sending>summary>\.kind\{display:none\}/, "the label is hidden only while the class is on");
  t.w.seen = 1000; t.apply(2500);
  assert.ok(!row.cls.has("sending") && !row.summary.dots && row.summary.kids.length === 2 && row.summary.kids[0].cls === "kind", "taken: the dots are gone and the label is the first thing again");
});

// #C1237 (Checker 2's LOW on #C1235): with the type label hidden, a screen reader must still hear that the thread is sending.
test("a screen reader hears Sending: the dots hold a visually hidden word, only the three dots are aria-hidden, and the word goes with them", () => {
  const t = world(); const row = t.w.mkRow("th-t1"); t.mark("t1", 1000);
  const d = row.summary.dots;
  assert.notEqual(d.attrs["aria-hidden"], "true", "the dots element itself is not hidden from a reader");
  const words = d.children.filter((c) => c.className === "sr");
  assert.equal(words.length, 1); assert.equal(words[0].textContent, "Sending", "the word is plain text, set as text (no innerHTML)");
  assert.ok(!words[0].attrs["aria-hidden"], "and not hidden");
  assert.equal(d.children.filter((c) => c.attrs["aria-hidden"] === "true").length, 3, "the three dots are decoration");
  assert.match(css, /\.sdots \.sr\{position:absolute;width:1px;height:1px;[^}]*overflow:hidden;clip:rect\(0 0 0 0\)[^}]*\}/, "visually hidden, not display:none (which a reader skips)");
  assert.ok(!/\.sdots \.sr\{[^}]*display:none/.test(css));
  assert.match(css, /\.sdots\{position:relative;/, "the hidden word is placed inside the dots element");
  assert.match(css, /\.sdots i:nth-of-type\(2\)\{animation-delay:\.2s\}\.sdots i:nth-of-type\(3\)\{animation-delay:\.4s\}/, "the pulse still runs left to right: the word is the first child, so the dots are counted among their own kind (Checker 2)");
  assert.ok(!/\.sdots i:nth-child/.test(css));
  t.w.seen = 1000; t.apply(2500);
  assert.ok(!row.summary.dots, "taken: the word goes with the dots and the type label is the title bar's first child again");
});

// ---- #C1241 (the owner: the same sending state everywhere his click goes to Manager, through one path) ----

test("every ask reply marks the ask before anything is awaited and clears it, opening the ask again, when the write fails (Done, help, an option, Ack, a note's Send)", () => {
  const body = script.slice(script.indexOf("async function onReply(e)"), script.indexOf("// Stores a reply's pending files"));
  assert.match(body, /btn\.disabled=true; lastPing="";\s*\/\/[^\n]*\n\s*markSending\(id\);\s*const anchor=await prepAnchor\(btn\);/, "marked at the click, before the first await, after the empty-note checks");
  assert.equal((body.match(/clearSending\(id,true\)/g) || []).length, 2, "a file that cannot be stored and a write that fails both open the ask again");
  assert.match(body, /Not saved \("\+\(err&&err\.code\|\|"error"\)\+"\)/, "with its Not saved line");
  assert.ok(body.indexOf("markSending(id)") > body.indexOf("Say in a few words what you'd like"), "a click that only asks for a note does not fold the ask");
  // The ask row is the thread's row by id: the shared path folds, grays and puts the dots in the type label's place for every ask kind.
  const t = world(); const asks = ["t2090", "t2091", "t2092"].map((id) => t.w.mkRow(id));
  t.mark("t2090", 1000);
  assert.ok(asks[0].cls.has("sending") && asks[0].open === false && asks[0].summary.dots && asks[0].summary.kids[0] === asks[0].summary.dots, "folded, gray, the dots first");
  assert.ok(!asks[1].cls.has("sending") && asks[1].open === true, "another ask is left alone");
  t.run('clearSending("t2090",true)');
  assert.ok(asks[0].open === true && !asks[0].cls.has("sending") && !asks[0].summary.dots, "a failed save: open again, the type label back");
  t.mark("t2090", 2000); asks[0].open = true; t.apply(3000);
  assert.ok(asks[0].open === true && asks[0].cls.has("sending"), "it stays clickable: reopened by hand it stays open and gray");
});

test("the new-thread form is sent through the same path: its thread row gets the state when the write draws it", () => {
  assert.match(script, /btn\.disabled=true;lastPing="";markSending\(id\);const anchor=await prepAnchor\(btn\);/);
  assert.ok(!/if\(key!=="new"\)markSending/.test(script));
  const t = world(); t.mark("t-1795000000000", 1000);
  const drawn = t.w.mkRow("th-t-1795000000000"); t.apply(1500);
  assert.ok(drawn.cls.has("sending") && drawn.summary.dots, "a row drawn after the click carries the state");
  assert.equal(t.folds().get("t-1795000000000"), false, "and is drawn folded: the fold is remembered (restoreFolds)");
});

test("the buttons that are not a row to fold take the dots in place of their label: Ping, Check, Let's start, a context tile's refresh", () => {
  const t = world();
  const ping = t.w.mkBtn({ tping: "t5" }), check = t.w.mkBtn({ check: "card-a" }), start = t.w.mkBtn({ td: "start", id: "idea-1", coll: "ideas" }), ctx = t.w.mkBtn({ ctxref: "Builder" });
  const move = t.w.mkBtn({ td: "up", id: "idea-1", coll: "ideas" }), other = t.w.mkBtn({ tping: "t6" });
  assert.deepEqual([ping, check, start, ctx, move].map((b) => t.run(`btnKeyOf(${JSON.stringify({ dataset: b.dataset })})`)), ["b:ping:t5", "b:check:card-a", "b:start:idea-1", "b:ctx:Builder", null], "each control has its own key; the arrows have none");
  for (const [key, b] of [["b:ping:t5", ping], ["b:check:card-a", check], ["b:start:idea-1", start], ["b:ctx:Builder", ctx]]) {
    t.run(`markButton(${JSON.stringify(key)},1000)`);
    assert.ok(b.cls.has("sbtn"), `${key}: the button wears the state`);
    assert.ok(b.dots && b.dots.children.some((c) => c.className === "sr" && c.textContent === "Sending"), `${key}: the dots are in the button, with the word for a reader`);
    assert.equal(b.dots.children.filter((c) => c.attrs["aria-hidden"] === "true").length, 3);
  }
  assert.ok(!move.cls.has("sbtn") && !other.cls.has("sbtn") && !other.dots, "another button is left alone");
  t.apply(2000); t.apply(3000);
  assert.equal(ping.adds, 1, "one dots element however many draws");
  // A redraw makes a new button for the same control: it gets the state back.
  const fresh = t.w.mkBtn({ tping: "t5" }); t.w.btns.splice(t.w.btns.indexOf(ping), 1); t.apply(4000);
  assert.ok(fresh.cls.has("sbtn") && fresh.dots, "a redrawn button carries it");
  // A failed write ends it at once.
  t.run('clearSending("b:ping:t5")'); assert.ok(!fresh.cls.has("sbtn") && !fresh.dots, "the dots go, the label is back");
});

test("a button's state ends when Manager has taken it (the delivered time, or his word in the thread it writes to) or after ten minutes, and never folds a row", () => {
  const t = world({ live: true, seen: 999, messages: [] }); const row = t.w.mkRow("th-t5"), ping = t.w.mkBtn({ tping: "t5" });
  t.run('markButton("b:ping:t5",1000)');
  assert.ok(ping.cls.has("sbtn") && row.open === true && !row.cls.has("sending"), "the thread row is not touched by a button's state");
  t.w.seen = 1000; t.apply(1500); assert.ok(!ping.cls.has("sbtn") && t.size() === 0, "delivered at or after it: taken");
  const u = world({ live: false, messages: [{ from: "Manager", at: 2000, thread: "card-a" }, { from: "Manager", at: 2000, thread: "elsewhere" }] }); const c = u.w.mkBtn({ check: "card-a" }), d = u.w.mkBtn({ check: "card-b" });
  u.run('markButton("b:check:card-a",1000)'); u.run('markButton("b:check:card-b",1000)'); u.apply(1500);
  assert.ok(!c.cls.has("sbtn"), "Manager wrote in that thread after it: taken");
  assert.ok(d.cls.has("sbtn"), "his word in another thread does not end it");
  assert.equal(u.run('btnThread("b:ctx:Builder")'), "ctx-Builder", "a tile's refresh writes to its ctx thread");
  assert.equal(u.run('btnThread("b:start:idea-1")'), "idea-1"); assert.equal(u.run('btnThread("t5")'), null);
  const v = world({ live: false }); const p = v.w.mkBtn({ tping: "t5" }); v.run('markButton("b:ping:t5",1000)');
  v.apply(1000 + 9 * 60e3); assert.ok(p.cls.has("sbtn")); v.apply(1000 + 10 * 60e3 + 1); assert.ok(!p.cls.has("sbtn"), "ten minutes at most");
});

test("each button's handler marks before it awaits and clears when its write fails", () => {
  assert.match(script, /markButton\(sk\);[^\n]*\n\s*lastPing="";const anchor=await prepAnchor\(b\),sent=await sendPing\(/, "Ping");
  assert.equal((script.match(/clearSending\(sk\)/g) || []).length, 6, "Ping: not sent and refused (2); Check: failed and thrown (2); Let's start: failed (1); a tile's refresh: failed (1)");
  assert.match(script, /const sk="b:check:"\+i\.id;if\(dbRef\)markButton\(sk\);\s*try\{if\(!await pressCheck\(i\.id\)\)clearSending\(sk\)\}/, "Check");
  assert.match(script, /return !\(dbRef&&r\[1\]\.status==="rejected"\)\}/, "Check knows its write failed (it used to swallow it)");
  assert.match(script, /const t=list\[i\],sk="b:start:"\+t\.id;markButton\(sk\);const anchor=await prepAnchor\(b\);/, "Let's start");
  assert.match(script, /const sk="b:ctx:"\+n;markButton\(sk\);\s*const anchor=await prepAnchor\(r\);/, "a context tile's refresh");
});

test("the look of a button with the dots: its label hidden but kept (for width and a reader), the dots centred, same colours and pulse", () => {
  assert.match(css, /\.sbtn\{position:relative;color:transparent!important\}/);
  assert.match(css, /\.sbtn>\.sdots\{position:absolute;inset:0;justify-content:center;align-items:center;padding:0;min-height:0\}/);
  assert.ok(!/\.sbtn[^{]*\{[^}]*(opacity|display:none|#[0-9a-fA-F]{3,6})/.test(css), "no colour of its own, never display:none (a reader skips it)");
});
