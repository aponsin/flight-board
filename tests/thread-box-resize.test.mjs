// #C1292 (the owner: "I want to drag the corner of the thread box to make it taller"): the thread's scroll box (.t-hist) can be resized by its bottom corner (resize: vertical, a visible
// handle, a floor and a ceiling), its height is remembered in this browser, and on a phone the box grows to fit. The CSS is read from the template; the script is driven with fake boxes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const NAMES = ["histClamp", "histHeightLoad", "histHeightSave", "histSizes", "histDown", "histUp", "HIST_MIN"];
const KEY = "flight-board-thread-box-height";

function load(stored = {}) {
  const store = new Map(Object.entries(stored));
  const writes = [];
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { if (k === KEY) writes.push([k, v]); store.set(k, String(v)); } }; // the page writes its read marks here too; only this card's key is recorded
  const b = loadNames(NAMES, { localStorage });
  return { b, store, writes, listeners: b.listeners };
}
// A fake thread box: a rectangle, a style, a class list, and the content height it needs.
function box({ height = 300, scrollHeight = 700, right = 800, bottom = 600 } = {}) {
  const h = { style: {}, scrollHeight, classes: new Set(), classList: { add: (c) => h.classes.add(c) }, rect: { right, bottom, height }, getBoundingClientRect: () => h.rect };
  h.closest = (sel) => (sel === ".t-hist" ? h : null);
  return h;
}
const press = (h, dx = 0, dy = 0, extra = {}) => ({ target: h, button: 0, clientX: h.rect.right - 5 + dx, clientY: h.rect.bottom - 5 + dy, ...extra });

test("the css: the box resizes vertically with a visible handle, a floor and a ceiling once sized; on a phone it grows to fit and does not resize", () => {
  assert.match(template, /\.t-hist\{resize:vertical\}/);
  assert.match(template, /\.t-hist\.sized\{min-height:6rem;max-height:80vh\}/);
  assert.match(template, /\.t-hist::-webkit-resizer\{background:linear-gradient\([^}]*var\(--muted\)/);
  const phone = /@media \(max-width:600px\)\{\.t-hist,\.t-hist\.sized\{([^}]*)\}\}/.exec(template);
  assert.ok(phone, "a phone rule for the box");
  for (const part of ["max-height:none", "min-height:0", "height:auto!important", "overflow-y:visible", "resize:none"]) assert.ok(phone[1].includes(part), part);
  assert.doesNotMatch(template, /\.t-hist\{max-height:min\(19rem,48vh\)\}/, "the old half-screen cap on a phone is gone");
  assert.match(template, /\.t-hist\{max-height:19rem;overflow-y:auto/, "the laptop's default height is unchanged until the corner is pressed");
});

test("the remembered height is one clamped number: never below the floor, never above 4000, nothing for rubbish", () => {
  const { b } = load();
  assert.equal(b.histClamp(50), b.HIST_MIN);
  assert.equal(b.histClamp(99999), 4000);
  assert.equal(b.histClamp(412.6), 413);
  for (const v of ["abc", 0, -5, null, undefined, NaN, Infinity]) assert.equal(b.histClamp(v), 0, String(v));
});

test("a press on the corner fixes the box at its height and lifts its cap; a drag then saves the new height", () => {
  const { b, listeners, writes } = load();
  const h = box({ height: 300 });
  listeners.pointerdown[0](press(h));
  assert.equal(h.style.height, "300px");
  assert.ok(h.classes.has("sized"));
  h.rect.height = 520; // the browser's own drag moved the corner
  for (const fn of listeners.pointerup) fn({});
  assert.deepEqual(writes, [[KEY, "520"]]);
  for (const fn of listeners.mouseup) fn({});
  assert.equal(writes.length, 1, "the same drag is saved once, however many ups arrive");
});

test("a click on the corner without moving it, a press elsewhere on the box and a right-click save nothing", () => {
  const { b, listeners, writes } = load();
  const h = box({ height: 300 });
  listeners.pointerdown[0](press(h));
  for (const fn of listeners.pointerup) fn({});
  assert.equal(writes.length, 0, "no move, no save");
  const h2 = box();
  listeners.pointerdown[0]({ target: h2, button: 0, clientX: h2.rect.right - 200, clientY: h2.rect.bottom - 200 });
  assert.equal(h2.style.height, undefined);
  assert.ok(!h2.classes.has("sized"));
  const h3 = box();
  listeners.pointerdown[0](press(h3, 0, 0, { button: 2 }));
  assert.equal(h3.style.height, undefined);
  listeners.pointerdown[0]({ target: { closest: () => null }, button: 0, clientX: 1, clientY: 1 });
  h3.rect.height = 900; for (const fn of listeners.pointerup) fn({});
  assert.equal(writes.length, 0);
});

test("after a redraw every thread box takes the remembered height, but never more than its messages need", () => {
  const { b } = load({ [KEY]: "400" });
  const tall = box({ scrollHeight: 900 }), short = box({ scrollHeight: 180 });
  b.document.querySelectorAll = () => [tall, short];
  b.histSizes();
  assert.equal(tall.style.height, "400px");
  assert.equal(short.style.height, "180px", "a short thread is not padded to the remembered height");
  assert.ok(tall.classes.has("sized") && short.classes.has("sized"));
});

// Checker 2's F1 on 98888dd9: .sized carries min-height:6rem, and a remembered height put .sized on every box, so a one-message box (47 px) grew to 98 px in real browsers while the
// tests, which fake scrollHeight, saw nothing. A remembered height must not give a box the floor: its own min-height is 0 (inline beats the class), and only the box being dragged gets the floor back.
test("a remembered height never makes a box taller than its content: the box is sized with its own floor at 0, and the corner press gives the dragged box the floor back", () => {
  const { b, listeners } = load({ [KEY]: "400" });
  const short = box({ scrollHeight: 47 });
  b.document.querySelectorAll = () => [short];
  b.histSizes();
  assert.equal(short.style.minHeight, "0", "the class's 6rem floor is overridden for a redrawn box");
  assert.equal(short.style.height, "47px");
  listeners.pointerdown[0](press(short));
  assert.equal(short.style.minHeight, "", "the box being dragged gets the class floor back");
});

test("with nothing remembered the boxes are left as they were", () => {
  const { b } = load();
  const h = box();
  b.document.querySelectorAll = () => [h];
  b.histSizes();
  assert.equal(h.style.height, undefined);
  assert.ok(!h.classes.has("sized"));
});

test("a browser with no usable storage still works: nothing is remembered and nothing throws", () => {
  const b = loadNames(NAMES, { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
  assert.equal(b.histHeightLoad(), 0);
  b.histHeightSave(400);
  const h = box();
  b.document.querySelectorAll = () => [h];
  b.histSizes();
  assert.equal(h.style.height, undefined);
});

test("a remembered value that is not a number is ignored", () => {
  const { b } = load({ [KEY]: "tall" });
  assert.equal(b.histHeightLoad(), 0);
});
