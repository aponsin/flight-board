// An old memory tile has a Refresh action (#C354, the owner in #T961; Manager's call A): a tile whose reading is over
// 2 h old shows Refresh. A click writes ctxRequests/<Role> {at} and pings the lead, who runs the collector. The tile
// says "refreshing…" until a newer reading lands; after 10 min with none it says plainly that the session isn't
// running (the app reads only running sessions). No new service, no new secret.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const H = 3600e3, MIN = 60e3;
const b = loadNames(["ctxTileHtml", "ctxRefreshWrites", "ctxPingText", "ctxRequest"]);

test("a tile read in the last 2 h has no Refresh; an older one says how old, and its Refresh stays at full strength", () => {
  const now = Date.now();
  assert.doesNotMatch(b.ctxTileHtml("Sales", { pct: 30, at: now - H }, null, now), /data-ctxref|stale/);
  const old = b.ctxTileHtml("Sales", { pct: 30, at: now - 3 * H }, null, now);
  assert.match(old, /^<div class="ctx-t g stale"/, "Designer on f8d3e56: the contents fade, not the whole tile");
  assert.doesNotMatch(old, /opacity/);
  assert.match(old, /<span class="ctx-line"><span class="ctx-st">3 h old<\/span> <button type="button" class="ctx-ref" data-ctxref="Sales" aria-label="Refresh Sales's memory reading" title="Refresh Sales's memory reading">↻<\/button><\/span>/, "its age, then ↻ alone, as on cards (#C361)");
  assert.match(page, /\.ctx-t\.stale>:not\(\.ctx-line\),\.ctx-t\.stale \.ctx-st\{opacity:\.55\}/, "the link isn't faded");
});

test("a click writes ctxRequests/<Role> {at} and pings the lead with one plain line", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(b.ctxRefreshWrites("Sales", 1_800_000_000_000))), [{ op: "set", path: "ctxRequests/Sales", data: { at: 1_800_000_000_000 } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.ctxRefreshWrites("../meta/x", 1))), [], "only a role name makes a document id");
  assert.equal(b.ctxPingText("Sales"), "Board: refresh Sales's memory tile (wake Sales, then run board-collector)", "#C361: the lead wakes the agent first");
});

test("#C361: the lead's answer on the request shows at once: 'no answer' says so; a newer request waits again", () => {
  const now = Date.now(), tile = { pct: 30, at: now - 3 * H };
  const none = b.ctxTileHtml("Sales", tile, { at: now - 3 * MIN, doneAt: now - MIN, outcome: "no answer" }, now);
  assert.match(none, /<span class="ctx-st">Sales didn&#39;t answer<\/span>/, "well before the 10-minute fallback");
  assert.match(none, /data-ctxref="Sales"/, "it can be tried again");
  const updated = b.ctxTileHtml("Sales", tile, { at: now - 3 * MIN, doneAt: now - MIN, outcome: "updated" }, now);
  assert.match(updated, /<span class="ctx-st">waking Sales…<\/span>/, "'updated' but the new reading hasn't reached the page yet: still waiting for it");
  const fresh = b.ctxTileHtml("Sales", { pct: 52, at: now - 30e3 }, { at: now - 3 * MIN, doneAt: now - MIN, outcome: "updated" }, now);
  assert.doesNotMatch(fresh, /ctx-st|data-ctxref/, "the reading landed");
  const older = b.ctxTileHtml("Sales", tile, { at: now - MIN, doneAt: now - 5 * MIN, outcome: "no answer" }, now);
  assert.match(older, /waking Sales…/, "an answer older than the request belongs to an earlier one");
});

test("waking <Role>… until a newer reading lands; after 10 min with no answer, it says the session isn't running", () => {
  const now = Date.now(), tile = { pct: 30, at: now - 3 * H };
  const wait = b.ctxTileHtml("Sales", tile, { at: now - 2 * MIN }, now);
  assert.match(wait, /<span class="ctx-st">waking Sales…<\/span>/);
  assert.doesNotMatch(wait, /data-ctxref/, "no second click while it waits");
  const none = b.ctxTileHtml("Sales", tile, { at: now - 11 * MIN }, now);
  assert.match(none, /<span class="ctx-st">no new reading: Sales&#39;s session isn&#39;t running<\/span>/, "escaped like any board text");
  assert.match(none, /data-ctxref="Sales"/, "it can be tried again");
  const fresh = b.ctxTileHtml("Sales", { pct: 41, at: now - MIN }, { at: now - 5 * MIN }, now);
  assert.doesNotMatch(fresh, /ctx-st|data-ctxref|stale/, "the new reading landed: a plain tile again");
  assert.match(fresh, /<span class="pc">41%<\/span>/);
});

test("a request is the newest of this role's, read from the board's ctxRequests", () => {
  const st = loadNames(["ctxRequest"]);
  st.state.ctxRequests = [{ id: "Sales", at: 5 }, { id: "Ops", at: 9 }];
  assert.equal(st.ctxRequest("Sales").at, 5);
  assert.equal(st.ctxRequest("Nobody"), null);
  assert.match(page, /\["initiatives",[^\]]*"ctxRequests"[^\]]*\]\.forEach\(sub\)/, "the board listens to the requests");
});
