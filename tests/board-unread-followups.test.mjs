// #C1271 (Checker 2's LOW on #C1266 and the Designer's note on #C1268): a thread dropped from the per-browser read store past 300 threads
// keeps what was read as read; and the buttons of a decision's options sit on one line when the pictures differ in height.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
const T = 1_800_000_000_000;
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)) }; };
const rule = (sel) => { const i = css.indexOf(sel + "{"); assert.ok(i >= 0, sel + " has a rule"); return css.slice(i, css.indexOf("}", i)); };

test("a thread dropped past 300 keeps its read replies read (they do not come back as new)", () => {
  const realNow = Date.now; Date.now = () => T;
  const b = loadNames(["threadOf", "newReplies", "seenAt", "markThreadSeen", "OWNER"], { localStorage: memory() });
  Date.now = realNow;
  b.state.messages = [{ id: "m0", thread: "t0", from: "Manager", text: "an answer", at: T + 10 }];
  assert.equal(b.newReplies("t0").length, 1, "new before it is read");
  b.markThreadSeen("t0", T + 100);
  assert.equal(b.newReplies("t0").length, 0, "read");
  for (let n = 1; n <= 300; n++) b.markThreadSeen("t" + n, T + 100 + n); // t0 is now the oldest of 301 and is dropped
  assert.equal(b.newReplies("t0").length, 0, "t0 was dropped from the store, and its old reply is still read");
  b.state.messages.push({ id: "m1", thread: "t0", from: "Manager", text: "a later answer", at: T + 5000 });
  assert.equal(b.newReplies("t0").length, 1, "a reply written after it is new");
});

test("the options' lines stretch to one height and put the button on the last row, so buttons line up under pictures of different heights", () => {
  assert.match(rule(".opt-grid"), /align-items:stretch/);
  assert.match(rule(".opt-grid>.opt-line"), /grid-template-rows:1fr auto/);
});
