// #C1404 (Designer's note on #C1402): a group tile's hover counted its cards in the tile's internal name ("1 of 3 cards afterwork", "1 of 3 cards future"). It now says plain words, the ones a card's
// own tile and pill use. The hover is the title only; the tile's look is unchanged. Also Checker 2's nit on #C1402: `let cls=...;` and `const words=...` were on one line.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, readingDoc, setReadings } from "./harness.mjs";

const NAMES = ["groupRow", "initRow", "gates", "enrich", "state"];
function group(initRaw, readings) {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(NAMES, { document });
  Object.assign(b.state, { initRaw, initiatives: initRaw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  setReadings(b, ...Object.entries(readings).map(([id, over]) => readingDoc(id, over)));
  return b.groupRow("g5-thing", b.state.initiatives).split('<div class="g-rail">')[0];
}
const raw = (id, num) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + num * 60e3 });
const ids = ["a", "b", "c"], cards = ids.map((id, k) => raw(id, k + 1));
const hovers = (html) => [...html.matchAll(/<div class="step[^"]*" title="([^"]*)">/g)].map((m) => m[1]);
const counted = (html) => hovers(html).map((t) => /^([^:]+): (\d) of 3 cards (.+)$/.exec(t)).filter(Boolean).map((m) => ({ label: m[1], n: Number(m[2]), phrase: m[3] }));

const PLAIN = new Set(["done", "working", "stuck", "not read yet", "waiting on you", "waiting", "queued", "not started yet", "waiting for pack or install", "waiting for pack", "waiting for install", "waiting for deploy", "sent back"]); // #C1406 restated: "sent back" is a plain word a card's own pill uses (a group tile of sent-back cards)
const RAW = ["afterwork", "future", "unknown", "ask", "wait"]; // the tile names that are not plain words (done, working, stuck, queued are words a card's tile shows too)

test("Designer's two cases: one card waiting for install among three reads 'waiting for install', one not started reads 'not started yet'", () => {
  const install = { phase: "install", state: "waiting", wait: "install", with: null, pack: "pc125" }, work = { phase: "install", state: "working", wait: null, with: "Boardsmith", working: true };
  // one card at Install waiting for install, two working at Install: the winning tile (working) holds 2, afterwork is hidden; make afterwork the winner with 1: a stuck-free group of one afterwork and two done
  const done = { phase: "live", state: "done", wait: null, with: null };
  const a = counted(group(cards, { a: install, b: done, c: done })).find((x) => x.label === "Install");
  assert.deepEqual(a && [a.n, a.phrase], [1, "waiting for install"], "1 of 3 cards waiting for install");
  const f = counted(group(cards, { a: { phase: "build", state: "working", wait: null, with: "Boardsmith", working: true }, b: work, c: work })).find((x) => x.label === "Land");
  assert.ok(f, "a count on Land");
  assert.equal(f.phrase, "not started yet", "cards before Land: 'not started yet', not 'future'");
});

test("two afterwork cards on different waits (pack, install) among three read 'waiting for pack or install', not one wait's words (Checker 2's F1)", () => {
  const working = { phase: "live", state: "done", wait: null, with: null };
  const pack ={ phase: "install", state: "waiting", wait: "pack", with: null }, install = { phase: "install", state: "waiting", wait: "install", with: null, pack: "pc125" };
  const a = counted(group(cards, { a: pack, b: install, c: working })).find((x) => x.label === "Install");
  assert.deepEqual(a && [a.n, a.phrase], [2, "waiting for pack or install"], "2 of 3 cards waiting for pack or install");
});

const PHASES = ["build", "test", "language", "design", "checker", "security", "ship", "pack", "install", "live"];
const KINDS = {
  working: { state: "working", wait: null, with: "Builder", working: true },
  stuck: { state: "stuck", wait: null, with: "Builder" },
  unknown: { state: "unknown", wait: null, with: null },
  queued: { state: "queued", wait: null, with: null },
  rework: { state: "rework", wait: null, with: "Builder" },
  "wait turn": { state: "waiting", wait: "turn", with: "Checker" },
  "wait group": { state: "waiting", wait: "group", with: null },
  "wait land": { state: "waiting", wait: "land", with: null },
  "wait hold": { state: "waiting", wait: "hold", with: null },
  "wait ask": { state: "waiting", wait: "ask", with: null, ask: 7 },
  "wait pack": { state: "waiting", wait: "pack", with: null },
  "wait install": { state: "waiting", wait: "install", with: null, pack: "pc125" },
  "wait deploy": { state: "waiting", wait: "deploy", with: null },
  done: { state: "done", wait: null, with: null },
};
test("no hover on a group tile carries a raw tile name: every phase and every kind of reading, one card different from two others", () => {
  let n = 0;
  for (const phase of PHASES) for (const [name, kind] of Object.entries(KINDS)) {
    for (const other of [{ phase: "build", state: "working", wait: null, with: "Builder", working: true }, { phase: "live", state: "done", wait: null, with: null }]) {
      for (const c of counted(group(cards, { a: { phase, ...kind }, b: other, c: other }))) {
        assert.ok(PLAIN.has(c.phrase), `${phase} / ${name} / ${c.label}: "${c.phrase}" is not one of the plain words`);
        assert.equal(RAW.includes(c.phrase.split(" ").at(-1)), false, `${phase} / ${name} / ${c.label}: "${c.phrase}" ends in a raw tile name`);
        n++;
      }
    }
  }
  assert.ok(n > 100, `checked ${n} hovers`);
});

test("a tile where the cards agree has no count, as before; the tile's look is the class, not the hover", () => {
  const html = group(cards, Object.fromEntries(ids.map((id) => [id, { phase: "install", state: "waiting", wait: "install", with: null, pack: "pc125" }])));
  assert.equal(counted(html).filter((x) => x.label === "Install").length, 0);
  assert.match(html, /<div class="step waits rel" title="Install">/);
});

test("the page's source: the hover names tilePhrase, not the raw tile, and the two statements of line 2940 are on two lines", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /cards "\+tilePhrase\(t,topR\)/);
  assert.equal(/cards "\+t\}/.test(html), false, "the raw tile is no longer in the title");
  assert.equal(html.split("\n").some((l) => /let cls=/.test(l) && /const words=/.test(l)), false, "`let cls=...` and `const words=...` are not on one line");
});
