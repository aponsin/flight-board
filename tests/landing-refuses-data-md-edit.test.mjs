// #C1090: the landing job refuses a tip that ADDS a dated "Changes" line to docs/DATA.md (a card's line goes to docs/DATA.d/<card id>.md), except the fold card; a row, a
// principle or a reworded line still lands (Checker 2's F1 on v3). It reports FOLD DUE when five or more fragments wait on main. The fold is a signed card, not a commit
// the job makes: the Worker's self-deploy gate wants a Checker PASS and a Security SECURE on every commit it would deploy.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rmTemp } from "./harness.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { landPlan, landRun, FOLD_CARD, FOLD_DUE, DATA_FILE, addedDatedLines, fragmentCount, dataDiffArgs, fragmentListArgs } from "../scripts/board-land.mjs";

const NOW = 1_800_000_000_000;
const ok = { checker: "PASS Full at abc", security: "SECURE at abc" };
const sha = (n) => String(n).padStart(40, "0");
const head = (n, over = {}) => ({ branch: `build/card-${n}`, sha: sha(n), notes: ok, cards: [`card-${n}`], dataLines: 0, onMain: false, forward: true, ahead: 1, ...over });
const holds = (...ids) => ({ at: NOW - 60_000, cards: Object.fromEntries(ids.map((i) => [i, ""])) });

test("a tip that adds a dated line to docs/DATA.md is refused with the way out, and a tip that adds none is tried", () => {
  const p = landPlan({ heads: [head(1, { dataLines: 1 }), head(2, { dataLines: 0 })], holds: holds("card-1", "card-2"), now: NOW });
  assert.deepEqual(p.try.map((h) => h.sha), [sha(2)]);
  assert.equal(p.blocked.length, 1);
  assert.equal(p.blocked[0].sha, sha(1));
  assert.match(p.blocked[0].reasons[0], /docs\/DATA\.d\/<card id>\.md/);
  assert.match(p.blocked[0].reasons[0], /a row or a principle may still be edited/);
});

test("only the fold card may add dated lines: every card of the tip must be one, not just one of them", () => {
  const fold = landPlan({ heads: [head(1, { cards: ["fold-data-fragments"], dataLines: 9 })], holds: holds("fold-data-fragments"), now: NOW });
  assert.equal(fold.try.length, 1);
  const mixed = landPlan({ heads: [head(2, { cards: ["fold-data-fragments", "card-2"], dataLines: 9 })], holds: holds("fold-data-fragments", "card-2"), now: NOW });
  assert.deepEqual(mixed.try, []);
  assert.equal(mixed.blocked.length, 1);
  for (const id of ["fold-data-fragments", "fold-data-fragments-11-20"]) assert.ok(FOLD_CARD.test(id), id);
  for (const id of ["fold-data-fragmentsx", "refold-data-fragments", "fold-data", "card-fold-data-fragments", "fold-data-fragments-"]) assert.ok(!FOLD_CARD.test(id), id);
});

test("a tip that edits a row or a principle of docs/DATA.md (no dated line added) lands: #C857's rows and #C1075's mid-file edit (Checker 2's F1)", () => {
  assert.equal(landPlan({ heads: [head(1, { dataLines: 0 })], holds: holds("card-1"), now: NOW }).try.length, 1);
});

test("a tip whose docs/DATA.md change could not be read waits, naming why; it is not landed unchecked", () => {
  const p = landPlan({ heads: [head(1, { dataLines: null })], holds: holds("card-1"), now: NOW });
  assert.deepEqual(p.try, []);
  assert.match(p.waiting[0].why, /could not be read/);
  // A head with no dataLines at all (facts from an older reader) is not refused for it.
  assert.equal(landPlan({ heads: [head(2, { dataLines: undefined })], holds: holds("card-2"), now: NOW }).try.length, 1);
});

test("addedDatedLines: only added lines of the exact dated form count; null for a diff that could not be read, never 0", () => {
  const diff = ["diff --git a/docs/DATA.md b/docs/DATA.md", "--- a/docs/DATA.md", "+++ b/docs/DATA.md", "@@ -5 +5,3 @@",
    "+- 2026-11-16: a card's line", "+- 2026-11-17: another", "-- 2026-11-10: a removed dated line", "+| a row | changed |", "+Reworded principle text", "+ - 2026-11-16: indented, not a dated line",
    "+- 2026-11-1: short date", "+- 2026-11-16 no colon", " - 2026-11-15: context"].join("\n");
  assert.equal(addedDatedLines(diff), 2);
  assert.equal(addedDatedLines(""), 0, "an empty diff is a clean 0");
  assert.equal(addedDatedLines(null), null);
  assert.equal(addedDatedLines(undefined), null);
});

test("fragmentCount: card files only; the README, other paths and a folder look-alike do not count; nothing read is 0", () => {
  const list = ["docs/DATA.d/README.md", "docs/DATA.d/card-a.md", "docs/DATA.d/card-b.md", "docs/DATA.d/.hidden.md", "docs/DATA.d/Upper.md", "docs/DATA.d/sub/x.md", "docs/DATA.d/note.txt", "docs/DATA.md", "other/docs/DATA.d/card-c.md"].join("\n");
  assert.equal(fragmentCount(list), 2);
  assert.equal(fragmentCount(""), 0);
  assert.equal(fragmentCount(null), 0);
});

test("the git reads: three dots against the merge base (main's own edits do not count), --no-renames, the one file; and the fragment listing is main's folder", () => {
  assert.deepEqual(dataDiffArgs("abc", "def"), ["diff", "-U0", "--no-renames", "abc...def", "--", DATA_FILE]);
  assert.deepEqual(fragmentListArgs("origin/main"), ["ls-tree", "--name-only", "origin/main", "docs/DATA.d/"]);
  // Run for real: main adds a dated line AFTER the branch forked; the branch adds none. Three dots sees none; two dots would see main's line removed, not added by the branch.
  const dir = mkdtempSync(join(tmpdir(), "c1090-git-"));
  try {
    const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=nobody", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).trim();
    mkdirSync(join(dir, "docs/DATA.d"), { recursive: true });
    writeFileSync(join(dir, DATA_FILE), "# Data\n\nrow one\n");
    git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("switch", "-q", "-c", "branch"); writeFileSync(join(dir, DATA_FILE), "# Data\n\nrow one changed\n"); git("commit", "-q", "-am", "edit a row");
    const branchRow = git("rev-parse", "HEAD");
    git("switch", "-q", "main"); writeFileSync(join(dir, DATA_FILE), "# Data\n\nrow one\n- 2026-11-16: main's own line\n"); writeFileSync(join(dir, "docs/DATA.d/card-a.md"), "- 2026-11-16: x\n"); writeFileSync(join(dir, "docs/DATA.d/README.md"), "r\n");
    git("add", "-A"); git("commit", "-q", "-m", "main adds a line and a fragment");
    const main = git("rev-parse", "HEAD");
    assert.equal(addedDatedLines(git(...dataDiffArgs(main, branchRow))), 0, "the branch's own change is a row edit: no dated line (main's line is not the branch's)");
    git("switch", "-q", "-c", "line", base); writeFileSync(join(dir, DATA_FILE), "# Data\n\nrow one\n- 2026-11-18: the branch's line\n"); git("commit", "-q", "-am", "add a dated line");
    assert.equal(addedDatedLines(git(...dataDiffArgs(main, git("rev-parse", "HEAD")))), 1, "the branch's own dated line counts");
    assert.equal(fragmentCount(git(...fragmentListArgs(main))), 1, "the listing counts main's card file, not its README");
  } finally { rmTemp(dir); }
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
