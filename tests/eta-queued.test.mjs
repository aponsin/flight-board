// Every card says how long it should take (#C348, the owner on the board: "missing timings"): beside "so far" the
// card's size and its expected hours with when that comes due, from the median hours a step takes by size
// (nudges.etaHours). One due time per card, on that line only (Designer's FINDINGS on c6c6e839: a second one on the
// running tile competed with it). A card nobody has started (no build start logged, no branch the collector has seen)
// shows Build as queued, never lit as if someone were on it, and its line says how long it has waited, with no due.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard, step } from "./harness.mjs";

const H = 3600e3, MIN = 60e3;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function card(b, steps, fields = {}, derived = null) {
  b.state.steps = steps;
  b.state.waiting = [];
  b.state.derived = derived ? [{ id: "all", cards: { x: derived } }] : [];
  return b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", size: "S", ...fields }));
}

test("beside 'so far': the size, its expected hours and when that comes due; 'was due' once it has passed", () => {
  const b = loadBoard(), now = Date.now();
  const on = card(b, [step("x", "build", "Admin", "start", now - 20 * MIN)], { createdAt: now - 30 * MIN });
  assert.match(b.initRow(on), new RegExp(`so far · expected S 1\\.5 h, due ~${hhmm(now - 30 * MIN + 1.5 * H)}`));
  const late = card(b, [step("x", "build", "Admin", "start", now - 3 * H)], { createdAt: now - 4 * H });
  assert.match(b.initRow(late), new RegExp(`so far · expected S 1\\.5 h, was due ~${hhmm(now - 4 * H + 1.5 * H)}`));
  const done = card(b, [step("x", "build", "Admin", "start", now - 3 * H), step("x", "live", "Release", "end", now - H, { version: "v1" })], { createdAt: now - 4 * H, status: "done", doneAt: now - H });
  assert.doesNotMatch(b.initRow(done), /expected/, "a finished card says nothing more");
});

test("Designer 1: one due time per card; a running tile shows who and how long only", () => {
  const b = loadBoard(), now = Date.now();
  const i = card(b, [step("x", "build", "Admin", "start", now - 20 * MIN)], { createdAt: now - 30 * MIN, size: "M" });
  const html = b.initRow(i);
  assert.match(html, /class="step now"[^>]*>Build<small>Admin · 20 min<\/small>/);
  assert.equal(html.match(/due ~/g).length, 1, "the meta line's only");
});

test("a card nobody has started shows Build queued, not lit; a branch or a build start makes it started", () => {
  const b = loadBoard(), now = Date.now();
  const q = card(b, [], { phase: "plan", who: "Boardsmith", createdAt: now - 12 * MIN, etaLive: now + 2 * H });
  const html = b.initRow(q);
  assert.match(html, /class="step now queued"[^>]*>Build<small>queued · Boardsmith<\/small>/, "Designer 3: no time; the header has the ETA (#C370: whose queue, and its place when it has one)");
  assert.doesNotMatch(html, /class="step now"[^>]*>(Plan|Build)<small>Boardsmith/, "nothing lit as if someone were on it");
  assert.match(html, /<span class="state active">Queued<\/span>/);
  assert.match(html, /<span>Queued 12 min · expected S 1\.5 h once started<\/span>/, "Designer 2: no 'Started', no due");
  assert.doesNotMatch(html, /Started|due ~/);
  const branched = card(b, [], { phase: "plan", who: "Boardsmith", createdAt: now - 10 * MIN }, { phase: "build", head: { sha: "abc1234", branch: "x" }, firm: false });
  assert.doesNotMatch(b.initRow(branched), /queued/i, "the collector has seen its branch");
  const begun = card(b, [step("x", "build", "Boardsmith", "start", now - 5 * MIN)], { createdAt: now - 10 * MIN });
  assert.doesNotMatch(b.initRow(begun), /queued/i, "a build start logged");
});
