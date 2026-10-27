// Every card says how long it should take (#C348, the owner on the board: "missing timings"): beside "so far" the
// card's size and its expected hours with when that comes due, and on each running phase when it comes due, both from
// the median hours a step takes by size (nudges.etaHours). A card nobody has started (no build start logged, no branch
// the collector has seen) shows Build as queued with its ETA, never lit as if someone were on it.
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

test("each running phase says when it comes due, from when it started and the size's median", () => {
  const b = loadBoard(), now = Date.now();
  const i = card(b, [step("x", "build", "Admin", "start", now - 20 * MIN)], { createdAt: now - 30 * MIN, size: "M" });
  assert.match(b.initRow(i), new RegExp(`class="step now"[^>]*>Build<small>Admin · 20 min · due ~${hhmm(now - 20 * MIN + 3.5 * H)}`));
  const two = card(b, [step("x", "build", "Builder", "start", now - 2 * H), step("x", "build", "Builder", "end", now - H), step("x", "checker", "Checker", "start", now - 30 * MIN), step("x", "build", "Admin", "start", now - 10 * MIN)], { createdAt: now - 3 * H });
  const html = b.initRow(two);
  assert.match(html, new RegExp(`>Build<small>Admin · 1 h 10 min · due ~${hhmm(now - 70 * MIN + 1.5 * H)}`), "a phase lit beside the current one too: its whole time so far counts");
  assert.match(html, new RegExp(`>Checker<small>Checker · 20 min · due ~${hhmm(now - 20 * MIN + 1.5 * H)}`), "due follows the time the page shows (phaseTimes)");
});

test("a card nobody has started shows Build queued with its ETA, not lit; a branch or a build start makes it started", () => {
  const b = loadBoard(), now = Date.now();
  const q = card(b, [], { phase: "plan", who: "Boardsmith", createdAt: now - 10 * MIN, etaLive: now + 2 * H });
  const html = b.initRow(q);
  assert.match(html, new RegExp(`class="step now queued"[^>]*>Build<small>queued · live ~${hhmm(now + 2 * H)}</small>`));
  assert.doesNotMatch(html, /class="step now"[^>]*>(Plan|Build)<small>Boardsmith/, "nothing lit as if someone were on it");
  assert.match(html, /<span class="state active">Queued<\/span>/);
  const branched = card(b, [], { phase: "plan", who: "Boardsmith", createdAt: now - 10 * MIN }, { phase: "build", head: { sha: "abc1234", branch: "x" }, firm: false });
  assert.doesNotMatch(b.initRow(branched), /queued/, "the collector has seen its branch");
  const begun = card(b, [step("x", "build", "Boardsmith", "start", now - 5 * MIN)], { createdAt: now - 10 * MIN });
  assert.doesNotMatch(b.initRow(begun), /queued/, "a build start logged");
});
