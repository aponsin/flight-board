// A READY the board can't see (#C534, Checker on #C527): a rework pushed to a branch that already shipped, with no
// "Board-Id" trailer, reads as "extra commits after ship". When a build end step (the READY on the board) comes at or after
// that tip's commit, the collector's nudge 9 tells the lead to have the builder add the trailer. Fictional names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect } from "../collector/collect.mjs";
import { nudges } from "../collector/nudges.mjs";

const T0 = 1_790_000_000, PATTERN = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})", MIN = 60e3;
// The rework shape: shipped at `shipped` ("v1.2.1: admin/stale-fix@<sha>"), then a trailer-less rework on the same branch.
function reworked() {
  const dir = mkdtempSync(join(tmpdir(), "fb-aftership-ready-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (t, file, msg) => { at = T0 + t; appendFileSync(join(work, file), msg + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  g(["checkout", "-qb", "admin/stale-fix"]);
  const shipped = commit(10, "fix.md", "the fix");
  g(["checkout", "-q", "main"]); at = T0 + 20; g(["merge", "-q", "--no-ff", "-m", `v1.2.1: admin/stale-fix@${shipped.slice(0, 8)}`, shipped]);
  g(["checkout", "-q", "admin/stale-fix"]);
  const tip = commit(30, "fix.md", "the rework, no trailer");
  g(["checkout", "-q", "main"]);
  g(["push", "-q", "--all", "origin"]); g(["fetch", "-q", "origin"]);
  return { dir, git: (a) => g(a), shipped, tip, tipAt: (T0 + 30) * 1000, main: () => g(["rev-parse", "main"]).trim() };
}
const card = { id: "stale-fix", num: 521, status: "active", level: "Quick", size: "S", phase: "build" };
const teamConfig = (dir) => fullConfig({ owner: "Sam", roster: ["Manager", "Admin", "Checker"], collector: { repoPath: dir, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI", shippedPattern: PATTERN } });

test("the collector's derived card carries afterShip { branch, tip, extra, at } beside the evidence", () => {
  const r = reworked();
  try {
    const d = collect({ config: teamConfig(r.dir), cards: [card], git: r.git, gh: () => JSON.stringify([{ headSha: r.main() }]), now: 1 }).doc.cards["stale-fix"];
    assert.equal(d.head, r.shipped);
    assert.deepEqual(d.afterShip, { branch: "admin/stale-fix", tip: r.tip, extra: 1, at: r.tipAt });
    assert.match(d.evidence, /admin\/stale-fix has 1 extra commit after ship/);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

const config = fullConfig({ owner: "Sam", roster: ["Manager", "Admin", "Checker"] });
const TIP = "a".repeat(40), TIP_AT = 1_793_400_000_000, NOW = TIP_AT + 30 * MIN;
const derived = (extra = {}) => ({ "stale-fix": { phase: "live", head: "b".repeat(40), afterShip: { branch: "admin/stale-fix", tip: TIP, extra: 2, at: TIP_AT }, ...extra } });
const step = (at, more = {}) => ({ id: `stale-fix-build-end-${at}`, init: "stale-fix", phase: "build", kind: "end", who: "Admin", at, ...more });
const run = (docs, d = derived(), state = {}) => nudges({ config, docs: { initiatives: [card], messages: [], waiting: [], ...docs }, now: NOW, state, derived: d });

test("nudge 9: a READY logged at or after the tip, on a branch read as after-ship, asks for the trailer; forwarded to who logged it", () => {
  const { lines } = run({ steps: [step(TIP_AT + 5 * MIN)] });
  assert.deepEqual(lines.filter((l) => /after its ship|after stale-fix/.test(l)), [
    `NUDGE @Admin stale-fix (#C521): READY logged after its ship, but admin/stale-fix at aaaaaaaa has no "Board-Id: stale-fix" commit since the ship, so the board reads it as 2 extra commits after ship, not a new review. Please: a rework after stale-fix (#C521) shipped needs a commit with "Board-Id: stale-fix" (or its own branch and sub-card), or the board never shows it READY`,
  ]);
  assert.equal(run({ steps: [step(TIP_AT)] }).lines.filter((l) => /READY logged after its ship/.test(l)).length, 1, "a READY at the tip's own time counts");
  assert.equal(run({ steps: [step(TIP_AT, { init: "C521" })] }).lines.filter((l) => /READY logged after its ship/.test(l)).length, 1, "a step by card number counts");
});

test("nudge 9 holds back: a READY from before the tip, a start step, another phase or card, a closed card, no afterShip", () => {
  const none = (docs, d, c = card) => assert.deepEqual(nudges({ config, docs: { initiatives: [c], messages: [], waiting: [], ...docs }, now: NOW, state: {}, derived: d ?? derived() }).lines.filter((l) => /after its ship|after stale-fix/.test(l)), []);
  none({ steps: [step(TIP_AT - 1)] });
  none({ steps: [step(TIP_AT + MIN, { kind: "start" })] });
  none({ steps: [step(TIP_AT + MIN, { phase: "checker" })] });
  none({ steps: [step(TIP_AT + MIN, { init: "other-card" })] });
  none({ steps: [step(TIP_AT + MIN)] }, undefined, { ...card, status: "done" });
  none({ steps: [step(TIP_AT + MIN)] }, { "stale-fix": { phase: "live", head: "b".repeat(40) } });
  none({ steps: [step(TIP_AT + MIN)] }, derived({ afterShip: { branch: "admin/stale-fix", tip: "not-a-sha", extra: 2, at: TIP_AT } }));
});

test("nudge 9 is sent once per tip, then again after the quiet period; a new tip is a new nudge; a branch name that isn't plain prints '?'", () => {
  const docs = { steps: [step(TIP_AT + MIN)] };
  const first = run(docs);
  assert.equal(first.lines.filter((l) => /READY logged after its ship/.test(l)).length, 1);
  assert.equal(run(docs, derived(), first.state).lines.filter((l) => /READY logged after its ship/.test(l)).length, 0, "the next run: quiet");
  const nextTip = derived({ afterShip: { branch: "admin/stale-fix", tip: "c".repeat(40), extra: 3, at: TIP_AT } });
  assert.equal(run(docs, nextTip, first.state).lines.filter((l) => /READY logged after its ship/.test(l)).length, 1, "another tip: a new nudge");
  const odd = run(docs, derived({ afterShip: { branch: "x; rm -rf ~", tip: TIP, extra: 2, at: TIP_AT } }));
  assert.match(odd.lines.find((l) => /READY logged after its ship/.test(l)), /but \? at aaaaaaaa/);
});
