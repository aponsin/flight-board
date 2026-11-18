// #C1230 (the owner: the board's Safari tab used 2 GB). Three things the page now does so a long-open tab stays small, each run on the real text:
// (1) redraws add no listener anywhere that lives past a row: N whole redraws (data changing each time) leave the listener count on the document, the window and every section as it was after the first;
// (2) a thumbnail's picture is drawn once into a small copy (full image only in the lightbox), the copies are capped, and one still on the page is never dropped;
// (3) the shim keeps a short hash of each collection, not its JSON, and still tells exactly the collections that changed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { times, FIXTURES } from "../scripts/fixtures.mjs";
import { COMPAT_SHIM } from "../worker/compat-shim.mjs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---- (1) N redraws leave the listener count flat ----
function page() {
  const adds = { document: 0, window: 0, elements: 0 }, els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, scrollTop: 0, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() { adds.elements++; }, setAttribute() {}, removeAttribute() {},
    querySelectorAll: () => [], querySelector: () => null, appendChild() {}, getBoundingClientRect: () => ({ left: 0, width: 0, top: 0, height: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() { adds.document++; }, activeElement: null, createRange: () => ({}), createElement: () => el("_new"), images: [] };
  const ctx = { document, window: { scrollY: 0, scrollTo() {}, addEventListener() { adds.window++; } }, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}),
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: "", search: "" }, Date, Math, JSON, Number, String, Array, Object, Set, Map, WeakMap, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__b={state,renderAll};", ctx);
  return { b: ctx.__b, adds, els };
}

test("N whole redraws, the data changing each time, add no listener and keep every section the same size", () => {
  const { b, adds, els } = page();
  const docs = {};
  for (const f of readdirSync(FIXTURES)) for (const [k, v] of Object.entries(times(JSON.parse(readFileSync(new URL(f, "file://" + FIXTURES + "/"), "utf8")).docs || {}, Date.now()))) (docs[k] ||= []).push(...v.map((d) => ({ ...d, id: f + ":" + d.id })));
  for (const [c, list] of Object.entries(docs)) { const key = c === "initiatives" ? "initRaw" : c; if (Array.isArray(b.state[key])) b.state[key] = list; }
  b.renderAll();
  const base = { ...adds }, size = () => Object.values(els).reduce((n, e) => n + String(e.innerHTML).length, 0), first = size();
  assert.ok(first > 1000, "the fixtures drew something");
  for (let i = 0; i < 60; i++) { b.state.events = b.state.events.slice(); b.state.steps = b.state.steps.slice(); b.renderAll(); }
  assert.deepEqual(adds, base, "no listener was added by the 60 redraws");
  assert.equal(size(), first, "the same data draws the same size every time (nothing piles up in a section)");
});

// ---- (2) thumbnails as small copies ----
const fragment = script.slice(script.indexOf("const THUMB_W="), script.indexOf("function fileLinks(fs)"));
function thumbWorld() {
  const w = { images: [], revoked: [], drawn: [], loadHandler: null, redraws: 0, blobs: 0 };
  const canvas = () => { const c = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage: (...a) => w.drawn.push({ w: c.width, h: c.height, args: a.length }) }), toBlob: (cb) => cb({ size: 1 }) }; return c; };
  const ctx = { document: { images: w.images, createElement: () => canvas(), addEventListener: (t, f) => { if (t === "load") w.loadHandler = f; } }, URL: { createObjectURL: () => "blob:x" + ++w.blobs, revokeObjectURL: (u) => w.revoked.push(u) }, renderSoon: () => w.redraws++, Map, Set, Array };
  vm.createContext(ctx); vm.runInContext(fragment, ctx);
  const loaded = (src, wd, ht, inThumb = true) => w.loadHandler({ target: { tagName: "IMG", naturalWidth: wd, naturalHeight: ht, getAttribute: () => src, closest: () => inThumb } });
  return { w, ctx, loaded, thumbSrc: (u) => vm.runInContext("thumbSrc", ctx)(u), size: () => vm.runInContext("thumbs.size", ctx) };
}

test("a wide picture is drawn once into a 720 px copy and the thumbnail then shows the copy; the lightbox keeps the full address", () => {
  const t = thumbWorld();
  assert.equal(t.thumbSrc("/_blob/AAA"), "/_blob/AAA", "before the picture has loaded the thumbnail shows it as it was");
  t.loaded("/_blob/AAA", 2474, 490);
  assert.deepEqual(t.w.drawn, [{ w: 720, h: 143, args: 5 }], "drawn once at 720 wide, the same proportions");
  assert.equal(t.thumbSrc("/_blob/AAA"), "blob:x1");
  assert.equal(t.w.redraws, 1, "the page draws once more to swap it in");
  t.loaded("/_blob/AAA", 2474, 490); assert.equal(t.w.drawn.length, 1, "a picture already handled is not drawn again");
  assert.match(html, /data-full="\$\{esc\(safeImg\(i\.url\)\)\}"/, "the lightbox opens the full address");
});

test("a small picture, a picture outside a thumbnail and a copy's own blob address are left alone", () => {
  const t = thumbWorld();
  t.loaded("/_blob/SMALL", 713, 139); assert.equal(t.thumbSrc("/_blob/SMALL"), "/_blob/SMALL"); assert.equal(t.w.drawn.length, 0); assert.equal(t.w.redraws, 0);
  t.loaded("/_blob/OUT", 3000, 2000, false); assert.equal(t.w.drawn.length, 0);
  t.loaded("blob:x9", 3000, 2000); t.loaded("https://elsewhere.example/a.png", 3000, 2000); assert.equal(t.w.drawn.length, 0);
});

test("the copies are capped at 300, oldest first, and a copy still on the page is never dropped", () => {
  const t = thumbWorld();
  t.loaded("/_blob/KEEP0", 2000, 1000); t.w.images.push({ getAttribute: () => "blob:x1" });
  for (let i = 1; i < 400; i++) t.loaded("/_blob/P" + i, 2000, 1000);
  assert.equal(t.size(), 300);
  assert.equal(t.thumbSrc("/_blob/KEEP0"), "blob:x1", "the one on the page is still there");
  assert.ok(t.w.revoked.length >= 99 && !t.w.revoked.includes("blob:x1"), "the dropped ones were released, not the one in use");
});

// ---- (3) the shim keeps a hash, not the JSON ----
test("the shim tells exactly the collections that changed, by a hash of their text, and adds its one listener once", async () => {
  const timers = []; let docListeners = 0, compat = { collections: { waiting: [{ id: "a", text: "x".repeat(5000) }], todo: [{ id: "b", text: "y" }] }, probe: null }, tag = 0;
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  const fetch = async () => ({ status: 200, ok: true, headers: headers({ etag: '"' + ++tag + '"' }), json: async () => JSON.parse(JSON.stringify(compat)) });
  const document = { hidden: false, addEventListener() { docListeners++; } }, window = {};
  vm.runInNewContext(COMPAT_SHIM, { window, fetch, document, setInterval: (f) => (timers.push(f), 1), JSON, Promise, Object, String, Error, Math });
  const db = await window.claude.use("db"); const n = { waiting: 0, todo: 0 };
  db.collection("waiting").onSnapshot(() => n.waiting++); db.collection("todo").onSnapshot(() => n.todo++);
  const tick = () => new Promise((r) => setImmediate(r)); await tick();
  assert.deepEqual(n, { waiting: 1, todo: 1 });
  for (let i = 0; i < 50; i++) { await timers[0](); await tick(); }
  assert.deepEqual(n, { waiting: 1, todo: 1 }, "50 polls of the same data tell nobody");
  compat.collections.waiting[0].text = "x".repeat(4999) + "z";
  await timers[0](); await tick(); assert.deepEqual(n, { waiting: 2, todo: 1 }, "one changed character in a 5000-character text is seen");
  assert.equal(docListeners, 1, "one visibility listener however many polls and subscriptions");
});
