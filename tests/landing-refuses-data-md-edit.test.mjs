// #C1090: the landing job refuses a tip that edits docs/DATA.md (a card's line goes to docs/DATA.d/<card id>.md), except the fold card, and reports
// FOLD DUE when five or more fragments wait on main. The fold is a signed card, not a commit the job makes: the Worker's self-deploy gate wants a
// Checker PASS and a Security SECURE on every commit it would deploy.
import test from "node:test";
import assert from "node:assert/strict";
import { landPlan, landRun, FOLD_CARD, FOLD_DUE, DATA_FILE } from "../scripts/board-land.mjs";

const NOW = 1_800_000_000_000;
const ok = { checker: "PASS Full at abc", security: "SECURE at abc" };
const sha = (n) => String(n).padStart(40, "0");
const head = (n, over = {}) => ({ branch: `build/card-${n}`, sha: sha(n), notes: ok, cards: [`card-${n}`], changed: ["worker/x.mjs"], onMain: false, forward: true, ahead: 1, ...over });
const holds = (...ids) => ({ at: NOW - 60_000, cards: Object.fromEntries(ids.map((i) => [i, ""])) });

test("a tip that edits docs/DATA.md is refused with the way out, and a tip that does not is tried", () => {
  const p = landPlan({ heads: [head(1, { changed: ["worker/x.mjs", DATA_FILE] }), head(2, { changed: ["docs/DATA.d/card-2.md", "worker/y.mjs"] })], holds: holds("card-1", "card-2"), now: NOW });
  assert.deepEqual(p.try.map((h) => h.sha), [sha(2)]);
  assert.equal(p.blocked.length, 1);
  assert.equal(p.blocked[0].sha, sha(1));
  assert.match(p.blocked[0].reasons[0], /docs\/DATA\.d\/<card id>\.md/);
});

test("only the fold card may edit docs/DATA.md: every card of the tip must be one, not just one of them", () => {
  const fold = landPlan({ heads: [head(1, { cards: ["fold-data-fragments"], changed: [DATA_FILE, "docs/DATA.d/a.md"] })], holds: holds("fold-data-fragments"), now: NOW });
  assert.equal(fold.try.length, 1);
  const mixed = landPlan({ heads: [head(2, { cards: ["fold-data-fragments", "card-2"], changed: [DATA_FILE] })], holds: holds("fold-data-fragments", "card-2"), now: NOW });
  assert.deepEqual(mixed.try, []);
  assert.equal(mixed.blocked.length, 1);
  for (const id of ["fold-data-fragments", "fold-data-fragments-11-20"]) assert.ok(FOLD_CARD.test(id), id);
  for (const id of ["fold-data-fragmentsx", "refold-data-fragments", "fold-data", "card-fold-data-fragments", "fold-data-fragments-"]) assert.ok(!FOLD_CARD.test(id), id);
});

test("a path that only looks like docs/DATA.md is not the file", () => {
  for (const changed of [["docs/DATA.md.bak"], ["docs/DATA.d/DATA.md"], ["x/docs/DATA.md"], ["docs/data.md"]]) {
    assert.equal(landPlan({ heads: [head(1, { changed })], holds: holds("card-1"), now: NOW }).try.length, 1, JSON.stringify(changed));
  }
});

test("a tip whose changed paths could not be read waits, naming why; it is not landed unchecked", () => {
  const p = landPlan({ heads: [head(1, { changed: null })], holds: holds("card-1"), now: NOW });
  assert.deepEqual(p.try, []);
  assert.match(p.waiting[0].why, /could not be read/);
});

test("the run reports FOLD DUE at five waiting fragments, not at four", () => {
  const run = (n) => {
    const lines = [];
    const r = landRun({ readFacts: () => ({ heads: [] }), readHolds: () => holds(), release: () => ({ code: 0, text: "" }), now: NOW, log: (s) => lines.push(s), readFragments: () => n });
    return { r, lines };
  };
  assert.equal(FOLD_DUE, 5);
  const four = run(4);
  assert.equal(four.r.foldDue, false);
  assert.equal(four.r.dataFragments, 4);
  assert.deepEqual(four.lines, []);
  const five = run(5);
  assert.equal(five.r.foldDue, true);
  assert.match(five.lines.join("\n"), /FOLD DUE: 5 DATA fragments/);
  assert.equal(run(0).r.foldDue, false);
});

test("a fragment reader that throws does not stop the run", () => {
  const r = landRun({ readFacts: () => ({ heads: [] }), readHolds: () => holds(), release: () => ({ code: 0, text: "" }), now: NOW, readFragments: () => { throw new Error("no git"); } });
  assert.equal(r.foldDue, false);
  assert.equal(r.dataFragments, 0);
});
