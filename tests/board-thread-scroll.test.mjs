// #C1232 (the owner: an open thread with many back-and-forths takes too much height). A thread's messages sit in their own box with a height cap and a scroll bar;
// the reply box stays outside it; the box keeps its place across a redraw (a reader at the newest end stays there, one who scrolled to older messages keeps what he reads).
// threadHtml runs on the page's own script with a stand-in document; the place-keeping on its own text with a tiny list of boxes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

function page() {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, scrollTop: 0, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelectorAll: () => [], querySelector: () => null, appendChild() {}, getBoundingClientRect: () => ({ left: 0, width: 0, top: 0, height: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}), createElement: () => el("_new"), images: [] };
  const ctx = { document, window: { scrollY: 0, scrollTo() {}, addEventListener() {} }, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}),
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: "", search: "" }, Date, Math, JSON, Number, String, Array, Object, Set, Map, WeakMap, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__b={state,threadHtml,OWNER};", ctx);
  return ctx.__b;
}
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ id: "m" + i, thread: "t1", from: i % 2 ? "Manager" : "owner", text: "message number " + (i + 1), at: 1e12 + i * 6e4 }));

test("a thread of 12 messages draws them in one box, newest first, after its reply box", () => {
  const b = page(); b.state.messages = msgs(12).map((m) => ({ ...m, from: m.from === "owner" ? b.OWNER : m.from }));
  const h = b.threadHtml("t1", "x");
  assert.equal((h.match(/<div class="t-hist" data-hist="x-t1">/g) || []).length, 1, "one box");
  const box = h.slice(h.indexOf('<div class="t-hist"'));
  assert.equal((box.match(/class="t-msg/g) || []).length, 12, "all twelve inside it");
  assert.ok(box.indexOf("message number 12") < box.indexOf("message number 1<"), "newest first, as before: it opens at the newest");
  assert.ok(h.indexOf("<textarea") >= 0 && h.indexOf("<textarea") < h.indexOf('<div class="t-hist"'), "the reply box is not inside the scroll box");
  assert.ok(!h.slice(0, h.indexOf('<div class="t-hist"')).includes("t-msg"), "no message outside it");
});

test("a thread with no message draws no box", () => {
  const b = page(); b.state.messages = [];
  assert.ok(!b.threadHtml("t1", "x").includes("t-hist"));
});

test("the box is height-capped with its own scroll bar; on a phone it grows to fit instead (#C1292 replaced the half-screen cap)", () => {
  assert.match(css, /\.t-hist\{max-height:19rem;overflow-y:auto;/);
  assert.match(css, /@media \(max-width:600px\)\{\.t-hist,\.t-hist\.sized\{max-height:none;/);
});

// ---- the place across a redraw ----
const fragment = script.slice(script.indexOf("function histSave()"), script.indexOf("function keep(el,draw)"));
function run(before, after) {
  // before / after: [{key, top, height}] boxes in the page at the time of the save and of the restore.
  let list = before.map((b) => ({ dataset: { hist: b.key }, scrollTop: b.top, scrollHeight: b.height }));
  const ctx = { document: { querySelectorAll: () => list } }; vm.createContext(ctx); vm.runInContext(fragment, ctx);
  const back = vm.runInContext("histSave", ctx)();
  list = after.map((b) => ({ dataset: { hist: b.key }, scrollTop: 0, scrollHeight: b.height }));   // a drawn-again box starts at the top
  back();
  return list.map((b) => b.scrollTop);
}

test("a soft shadow at the bottom says there is more below: a panel-coloured cover that scrolls with the content over a fixed shadow (scroll bars are hidden until a scroll on a Mac and a phone)", () => {
  const rule = css.match(/\.t-hist\{[^}]*\}/)[0];
  assert.match(rule, /linear-gradient\(transparent,var\(--panel\) 70%\) 0 100%\/100% 28px no-repeat local/, "the cover moves with the content");
  assert.match(rule, /radial-gradient\(farthest-side at 50% 100%,var\(--hist-shade\),transparent\) 0 100%\/100% 10px no-repeat scroll/, "the shadow stays at the box's bottom");
});

test("the shadow's colour is a token in every theme: dark on the light panel, light on the dark one (a black shadow cannot show on a near-black panel)", () => {
  const defs = [...css.matchAll(/--panel:(#[0-9a-fA-F]{6});\s*--hist-shade:(rgba\([^)]*\));/g)].map((m) => ({ panel: m[1], shade: m[2] }));
  assert.equal(defs.length, 3, "the light block and both dark ones");
  assert.deepEqual(defs.filter((d) => d.panel === "#ffffff").map((d) => d.shade), ["rgba(0,0,0,.22)"]);
  assert.deepEqual(defs.filter((d) => d.panel === "#171e26").map((d) => d.shade), ["rgba(255,255,255,.16)", "rgba(255,255,255,.16)"]);
});

test("a reader at the newest end stays there when a message is added above", () => {
  assert.deepEqual(run([{ key: "x-t1", top: 0, height: 1000 }], [{ key: "x-t1", height: 1160 }]), [0]);
  assert.deepEqual(run([{ key: "x-t1", top: 2, height: 1000 }], [{ key: "x-t1", height: 1160 }]), [0]);
});

test("a reader who scrolled down to older messages keeps what he reads when one is added above him", () => {
  assert.deepEqual(run([{ key: "x-t1", top: 300, height: 1000 }], [{ key: "x-t1", height: 1160 }]), [460]);
  assert.deepEqual(run([{ key: "x-t1", top: 300, height: 1000 }], [{ key: "x-t1", height: 1000 }]), [300], "nothing added: where he was");
});

test("each box keeps its own place, a new box starts at the newest and a box that is gone costs nothing", () => {
  assert.deepEqual(run([{ key: "a-1", top: 40, height: 500 }, { key: "b-2", top: 0, height: 500 }, { key: "gone", top: 90, height: 500 }],
    [{ key: "b-2", height: 700 }, { key: "a-1", height: 500 }, { key: "new", height: 900 }]), [0, 40, 0]);
});

test("both redraw paths take the place before they draw and put it back after", () => {
  assert.match(script, /function keep\(el,draw\)\{const back=histSave\(\),/);
  assert.match(script, /draw\(\);restoreFolds\(el,open\);(?:applySending\(\);)?back\(\);/);
  assert.match(script, /function anchored\(draw\)\{const row=anchorRow\(\),back=histSave\(\);[\s\S]*?draw\(\);back\(\);/);
});
