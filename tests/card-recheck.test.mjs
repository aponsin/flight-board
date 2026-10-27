// A Check button on each initiative card (#C355, the owner in #T962; Manager's call: #C354's pattern): a click writes
// checkRequests/<card id> {at} and pings the lead ("Board: check card #C<n> …"); the lead asks the card's owner, updates
// the card and stamps checkedAt. The card says "checking…" until then, "checked HH:MM" after, and plainly that no answer
// came if 30 min pass without one. No new service, no new secret.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, step } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const MIN = 60e3;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const NAMES = ["initRow", "enrich", "gates", "checkWrites", "checkPingText", "checkLine"];
function card(b, fields = {}, req = null) {
  const now = Date.now();
  b.state.steps = [step("x", "build", "Admin", "start", now - 20 * MIN)];
  b.state.waiting = [];
  b.state.checkRequests = req ? [{ id: "x", ...req }] : [];
  return b.gates(b.enrich({ id: "x", num: 351, name: "X", size: "S", level: "Quick", skip: ["plan"], status: "active", createdAt: now - 30 * MIN, ...fields }));
}

test("an open card has a ↻ Check button; a finished one doesn't", () => {
  const b = loadNames(NAMES);
  assert.match(b.initRow(card(b)), /<button type="button" class="i-check" data-check="x" aria-label="Ask Manager whether #C351 is up to date">↻ Check<\/button>/);
  assert.doesNotMatch(b.initRow(card(b, { status: "done", doneAt: Date.now() - MIN, phase: "live" })), /data-check/);
});

test("a click writes checkRequests/<card id> {at} and pings the lead with the card's number", () => {
  const b = loadNames(NAMES);
  assert.deepEqual(JSON.parse(JSON.stringify(b.checkWrites("board-threads-compact", 1_800_000_000_000))), [{ op: "set", path: "checkRequests/board-threads-compact", data: { at: 1_800_000_000_000 } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.checkWrites("../meta/x", 1))), [], "only a card id makes a document id");
  assert.equal(b.checkPingText({ id: "board-threads-compact", num: 351 }), "Board: check card #C351 (board-threads-compact): is it up to date? Ask its owner, update it and stamp checkedAt");
  assert.equal(b.checkPingText({ id: "x" }), "Board: check card x: is it up to date? Ask its owner, update it and stamp checkedAt", "no number yet: its id");
});

test("checking… until the lead stamps checkedAt; then checked HH:MM; after 30 min with no stamp, it says so plainly", () => {
  const now = Date.now();
  assert.equal(loadNames(NAMES).checkLine({ id: "x" }, null, now), "", "never asked, never checked: nothing");
  const b = loadNames(NAMES);
  assert.match(b.checkLine({ id: "x" }, { at: now - 5 * MIN }, now), /^checking…$/);
  assert.equal(b.checkLine({ id: "x" }, { at: now - 31 * MIN }, now), `no answer yet: asked at ${hhmm(now - 31 * MIN)}`);
  assert.equal(b.checkLine({ id: "x", checkedAt: now - 2 * MIN }, { at: now - 5 * MIN }, now), `checked ${hhmm(now - 2 * MIN)}`);
  assert.equal(b.checkLine({ id: "x", checkedAt: now - 9 * MIN }, { at: now - 5 * MIN }, now), "checking…", "a stamp older than the request doesn't answer it");
  const html = b.initRow(card(b, {}, { at: now - 5 * MIN }));
  assert.match(html, /<span class="i-checked">checking…<\/span>/);
  assert.doesNotMatch(html, /data-check=/, "no second click while it waits");
  assert.match(page, /"timings","ctxRequests","checkRequests"\]\.forEach\(sub\)/, "the board listens to the requests");
});
