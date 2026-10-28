// A Check button on each initiative card (#C355, the owner in #T962; Manager's call: #C354's pattern): a click writes
// checkRequests/<card id> {at}. Since #C376 the Collector answers it by code (tests/check-by-code.test.mjs): no ping to
// the lead; a lead's own checkedAt still counts. No new service, no new secret.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames, step } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const MIN = 60e3;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const NAMES = ["initRow", "enrich", "gates", "checkWrites", "checkLine"];
function card(b, fields = {}, req = null) {
  const now = Date.now();
  b.state.steps = [step("x", "build", "Admin", "start", now - 20 * MIN)];
  b.state.waiting = [];
  b.state.checkRequests = req ? [{ id: "x", ...req }] : [];
  return b.gates(b.enrich({ id: "x", num: 351, name: "X", size: "S", level: "Quick", skip: ["plan"], status: "active", createdAt: now - 30 * MIN, ...fields }));
}

test("an open card's #C label is its Check button, with a small ↻; a finished one's is plain text", () => {
  const b = loadNames(NAMES);
  const html = b.initRow(card(b));
  // #C376, the owner (t-1793166475210): the label itself is the button, so no ↻ Check pill wraps onto its own line.
  assert.match(html, /<div class="i-name"><button type="button" class="c-num i-check" data-check="x" aria-label="Have the Collector check #C351 at its next run" title="Have the Collector check this card">#C351<span class="i-ic" aria-hidden="true">↻<\/span><\/button> <strong>X<\/strong>/);
  assert.equal(html.match(/data-check=/g).length, 1, "one button: no separate pill");
  assert.doesNotMatch(html, />↻ Check</);
  const done = b.initRow(card(b, { status: "done", doneAt: Date.now() - MIN, phase: "live" }));
  assert.doesNotMatch(done, /data-check/);
  assert.match(done, /<span class="t-numtxt c-num" title="Card number">#C351<\/span>/);
  assert.match(page, /\.c-num\.i-check\{[^}]*color:var\(--accent\)/, "the label reads as clickable");
});

test("a card with no number yet keeps the ↻ Check pill", () => {
  const b = loadNames(NAMES);
  assert.match(b.initRow(card(b, { num: undefined })), /<button type="button" class="i-check" data-check="x" aria-label="Have the Collector check X at its next run">↻ Check<\/button>/);
});

test("a click writes checkRequests/<card id> {at}, and nothing pings the lead", () => {
  const b = loadNames(NAMES);
  assert.deepEqual(JSON.parse(JSON.stringify(b.checkWrites("board-threads-compact", 1_800_000_000_000))), [{ op: "set", path: "checkRequests/board-threads-compact", data: { at: 1_800_000_000_000 } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.checkWrites("../meta/x", 1))), [], "only a card id makes a document id");
  assert.doesNotMatch(page, /checkPingText/, "#C376: no ping");
});

test("a lead's own checkedAt still answers a request; one older than the request doesn't", () => {
  const now = Date.now();
  assert.equal(loadNames(NAMES).checkLine({ id: "x" }, null, now), "", "never asked, never checked: nothing");
  const b = loadNames(NAMES);
  b.state.derived = [];
  assert.equal(b.checkLine({ id: "x", checkedAt: now - 2 * MIN }, { at: now - 5 * MIN }, now), `checked ${hhmm(now - 2 * MIN)}`);
  assert.match(b.checkLine({ id: "x", checkedAt: now - 9 * MIN }, { at: now - 5 * MIN }, now), /^checking…/, "a stamp older than the request doesn't answer it");
  const html = b.initRow(card(b, {}, { at: now - 5 * MIN }));
  assert.match(html, /<span class="i-checked">checking…/);
  assert.match(page, /\.i-checked\{font:400 \.75rem var\(--mono\);color:var\(--muted\)\}\s*\.i-checked\.is-late\{color:var\(--warn\)\}/);
  assert.doesNotMatch(html, /data-check=/, "no second click while it waits");
  assert.match(html, /<span class="t-numtxt c-num" title="Card number">#C351<\/span>/, "the label stays, as plain text");
  assert.match(page, /"timings","ctxRequests","checkRequests"(?:,"\w+")*\]\.forEach\(sub\)/, "the board listens to the requests");
});
