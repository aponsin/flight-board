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

test("a tile read in the last 2 h has no Refresh; an older one has it, faded", () => {
  const now = Date.now();
  assert.doesNotMatch(b.ctxTileHtml("Sales", { pct: 30, at: now - H }, null, now), /data-ctxref/);
  const old = b.ctxTileHtml("Sales", { pct: 30, at: now - 3 * H }, null, now);
  assert.match(old, /style="opacity:\.55"/);
  assert.match(old, /<button type="button" class="ctx-ref" data-ctxref="Sales" aria-label="Refresh Sales's memory reading">Refresh<\/button>/);
});

test("a click writes ctxRequests/<Role> {at} and pings the lead with one plain line", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(b.ctxRefreshWrites("Sales", 1_800_000_000_000))), [{ op: "set", path: "ctxRequests/Sales", data: { at: 1_800_000_000_000 } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.ctxRefreshWrites("../meta/x", 1))), [], "only a role name makes a document id");
  assert.equal(b.ctxPingText("Sales"), "Board: refresh Sales's memory tile (run board-collector)");
});

test("refreshing… until a newer reading lands; after 10 min with none, it says the session isn't running", () => {
  const now = Date.now(), tile = { pct: 30, at: now - 3 * H };
  const wait = b.ctxTileHtml("Sales", tile, { at: now - 2 * MIN }, now);
  assert.match(wait, /<span class="ctx-st">refreshing…<\/span>/);
  assert.doesNotMatch(wait, /data-ctxref/, "no second click while it waits");
  const none = b.ctxTileHtml("Sales", tile, { at: now - 11 * MIN }, now);
  assert.match(none, /<span class="ctx-st">no new reading: Sales&#39;s session isn&#39;t running<\/span>/, "escaped like any board text");
  assert.match(none, /data-ctxref="Sales"/, "it can be tried again");
  const fresh = b.ctxTileHtml("Sales", { pct: 41, at: now - MIN }, { at: now - 5 * MIN }, now);
  assert.doesNotMatch(fresh, /ctx-st|data-ctxref|opacity/, "the new reading landed: a plain tile again");
  assert.match(fresh, /<span class="pc">41%<\/span>/);
});

test("a request is the newest of this role's, read from the board's ctxRequests", () => {
  const st = loadNames(["ctxRequest"]);
  st.state.ctxRequests = [{ id: "Sales", at: 5 }, { id: "Ops", at: 9 }];
  assert.equal(st.ctxRequest("Sales").at, 5);
  assert.equal(st.ctxRequest("Nobody"), null);
  assert.match(page, /\["initiatives",[^\]]*"ctxRequests"[^\]]*\]\.forEach\(sub\)/, "the board listens to the requests");
});
