// A card being shipped takes the run's version and the queue counts on from it (#C508: #C500 shipped as v1.168.11 while
// its card said "Next: v1.168.12 (2nd)" and #C501, still queued, "Next: v1.168.11 (1st)"). Release shipped out of READY
// order in a minute-long run between two Collector runs. The page plans again from the live state's run, as
// collector/expected.mjs would; the guard says when versions cross.
import test from "node:test";
import assert from "node:assert/strict";
import { expectedVersions, guardExpected, crossedVersions } from "../collector/expected.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { loadNames } from "./harness.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", collector: { candidatePattern: "^build/ship-v" } });
const card = (num, id, extra = {}) => ({ id, num, name: id, size: "S", status: "active", ...extra });
const plain = (o) => JSON.parse(JSON.stringify(o));

// Tonight: #C499 shipping v1.168.10; #C501 (READY first) and #C500 queued; #C502 with Checker.
const cards = [card(499, "countdown"), card(501, "editor-language"), card(500, "no-demo-bar"), card(502, "in-review")];
const before = {
  countdown: { phase: "ship", readyAt: 1, shipping: true },
  "editor-language": { phase: "ship", readyAt: 2 },
  "no-demo-bar": { phase: "ship", readyAt: 3 },
  "in-review": { phase: "checker" },
};
// A minute on: #C499 on main as v1.168.10; #C500 shipping in build/ship-v1.168.11 (out of READY order).
const after = { ...before, countdown: { phase: "ship", version: "1.168.10" }, "no-demo-bar": { phase: "ship", readyAt: 3, shipping: true } };

test("one shipping at vN plus one queued gives vN and vN+1, whatever the READY order", () => {
  const e = expectedVersions({ cards, derived: after, live: { version: "1.168.9", mainVersion: "1.168.10" }, runOf: { "no-demo-bar": "build/ship-v1.168.11" }, config });
  assert.deepEqual(e["no-demo-bar"], { version: "1.168.11", shipping: true });
  assert.equal(e["editor-language"].version, "1.168.12");
  assert.equal(e["editor-language"].place, 1);
  assert.equal(e["in-review"].version, "1.168.13");
});

function page(exportCards, live) {
  const b = loadNames(["expectedNow", "replan", "versionNote", "probeEvent"]);
  b.state.initRaw = cards;
  b.state.derived = [{ id: "all", live: { version: "1.168.9" }, cards: exportCards }];
  if (live) b.probeEvent({ type: "data", result: { payload: live } });
  return b;
}
const liveOf = (card, onMain = false) => ({ v: 1, board: { at: Date.now() - 20e3 }, cards: { [card]: { phase: "ship", headSha12: "a1b2c3d4e5f6", onMain } }, agents: { Release: { state: "working", card, since: Date.now() - 60e3 } } });
// The export from the Collector's run at 03:47: #C499 shipping, the queue by READY order.
const exp0 = expectedVersions({ cards, derived: before, live: { version: "1.168.9" }, runOf: { countdown: "build/ship-v1.168.10" }, config });
const exportAt0347 = Object.fromEntries(Object.entries(before).map(([id, d]) => [id, { ...d, expected: exp0[id] }]));

test("the page plans again from the live state's run: the same versions expected.mjs gives with that run", () => {
  const b = page(exportAt0347, liveOf("no-demo-bar"));
  const want = expectedVersions({ cards, derived: after, live: { version: "1.168.9", mainVersion: "1.168.10" }, runOf: { "no-demo-bar": "build/ship-v1.168.11" }, config });
  const got = plain(b.expectedNow());
  for (const id of ["no-demo-bar", "editor-language", "in-review"]) assert.deepEqual(got[id], plain(want[id]), id);
});

test("the cards then read: #C500 Shipping now v1.168.11, #C501 Next v1.168.12 (1st)", () => {
  const b = page(exportAt0347, liveOf("no-demo-bar"));
  assert.match(b.versionNote(cards[2]), /Shipping now: <b>v1\.168\.11<\/b>/);
  assert.match(b.versionNote(cards[1]), /Next: <b>v1\.168\.12<\/b> \(1st/);
});

test("no re-plan without a run, for the run the export already has, or for a card already on main", () => {
  assert.equal(page(exportAt0347, null).expectedNow(), null);
  assert.equal(page(exportAt0347, liveOf("countdown")).expectedNow(), null, "the export's own run");
  assert.equal(page(exportAt0347, liveOf("no-demo-bar", true)).expectedNow(), null, "on main: deploying, not a run");
  const b = page(exportAt0347, null);
  assert.match(b.versionNote(cards[1]), /Next: <b>v1\.168\.11<\/b> \(1st/, "the export's word stands");
});

test("a batch mate ships with the run; a minor in the queue still steps a minor", () => {
  const exp = { a: { version: "1.2.4", place: 1, with: ["b"], bump: "patch" }, b: { version: "1.2.4", place: 1, with: ["a"], bump: "patch" }, c: { version: "1.3.0", place: 2, with: [], bump: "minor" }, r: { version: "1.4.1", earliest: true, bump: "patch" } };
  const b = loadNames(["replan"]);
  const got = plain(b.replan(exp, "c", "1.2.3"));
  assert.deepEqual(got.c, { version: "1.3.0", shipping: true });
  assert.deepEqual(got.a, { version: "1.3.1", place: 1, with: ["b"], bump: "patch" });
  assert.deepEqual(got.b, { version: "1.3.1", place: 1, with: ["a"], bump: "patch" });
  assert.deepEqual(got.r, { version: "1.3.2", earliest: true, bump: "patch" });
});

test("the guard: a queued card due at or below the run's version, or two places on one version, is crossed", () => {
  const open = new Map(cards.map((k) => [k.id, k]));
  const lines = crossedVersions({ "no-demo-bar": { version: "1.168.11", shipping: true }, "editor-language": { version: "1.168.11", place: 1 }, "in-review": { version: "1.168.12", earliest: true } }, open);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^#C501 waits for v1\.168\.11 but #C500 ships now in v1\.168\.11: the versions crossed/);
  const two = crossedVersions({ "editor-language": { version: "1.168.11", place: 1 }, "no-demo-bar": { version: "1.168.11", place: 2 } }, open);
  assert.match(two[0], /#C501 and #C500 are both due in v1\.168\.11 from two places/);
  assert.deepEqual(crossedVersions(expectedVersions({ cards, derived: after, live: { version: "1.168.9", mainVersion: "1.168.10" }, runOf: { "no-demo-bar": "build/ship-v1.168.11" }, config }), open), [], "one run's own prediction never crosses");
  const g = guardExpected({ cards, derived: after, expected: { "no-demo-bar": { version: "1.168.11", shipping: true }, "editor-language": { version: "1.168.11", place: 1 } } });
  assert.ok(g.lines.some((l) => /versions crossed/.test(l)), "the guard says it with its other conflicts");
});
