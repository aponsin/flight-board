// #C1239 (11-18, #C1236): a card whose commits had Board-Id in a paragraph of its own (above Co-Authored-By, so git reads no trailer) was matched only by the number in its branch name: build, signed [],
// "nothing pushed", and it stayed so after it was re-cut on a second branch and shipped ("v1.217.1: admin/c1236-demo-map@7f395db4"). The board now (1) says what is wrong with such a tip, (2) reads a
// card whose tips lack its trailer from the commit a ship commit on main cites for a branch of the card, and (3) never lets either override a tip that carries the card's own trailer.
// Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { looseBoardIdsOf, misplacedBoardId, boardIdsOf } from "../collector/board-id.mjs";
import { turnsOf } from "../collector/store-dispatch.mjs";
import { dispatchItems, dispatchLine, DISPATCH_TRAILER_TEXT } from "../gate/reset.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const CARD = { id: "demo-views-map", num: 1236, level: "Quick", phase: "build", owner_role: "Admin", repo: "demo" };
const SHIPPED = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})";
// The slip: Board-Id in a paragraph of its own, then a blank line, then Co-Authored-By. Git reads the last paragraph only: no trailer.
const SPLIT = (subject, id = CARD.id) => `${subject}\n\nBoard-Id: ${id}\n\nCo-Authored-By: Claude <noreply@example.com>`;
const ONE = (subject, id = CARD.id) => `${subject}\n\nBoard-Id: ${id}\nCo-Authored-By: Claude <noreply@example.com>`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-recut-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const sha = () => g(["rev-parse", "HEAD"]).trim();
  const onBranch = (name, t, message) => { g(["checkout", "-q", "main"]); g(["checkout", "-qB", name]); at = T0 + t; appendFileSync(join(work, `${name.replace(/\//g, "-")}.md`), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", message]); return sha(); };
  const sign = (s) => { for (const r of Object.keys(NOTES)) g(["notes", `--ref=${NOTES[r]}`, "add", "-m", r === "security" ? "SECURE" : "PASS", s]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); g(["checkout", "-q", "main"]); };
  const tip = (branch, s, t, message) => ({ branch, sha: s, at: (T0 + t) * 1000, message });
  const repo = (tips, extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, tips: [{ branch: "main", sha: "x", at: T0 * 1000, message: "" }, ...tips], live: null, versionPattern: null, ...extra });
  // Merge a branch to main with a ship subject that cites it as <branch>@<short sha>, then drop the branch (the old one stays).
  const ship = (name, s, version = "v1.0.1") => { g(["checkout", "-q", "main"]); at = T0 + 100; g(["merge", "-q", "--no-ff", "-m", `${version}: ${name}@${s.slice(0, 8)}`, name]); return sha(); };
  return { g, onBranch, sign, sync, tip, repo, ship };
}

const now = (T0 + 500) * 1000;

test("Board-Id in a paragraph of its own is no git trailer, but it is seen as misplaced; a real trailer, or another card's line, is not", () => {
  assert.deepEqual(boardIdsOf(SPLIT("s")), [], "git reads no trailer");
  assert.deepEqual(looseBoardIdsOf(SPLIT("s")), [CARD.id]);
  assert.equal(misplacedBoardId(SPLIT("s"), CARD.id), true);
  assert.equal(misplacedBoardId(ONE("s"), CARD.id), false, "a real trailer is not misplaced");
  assert.equal(misplacedBoardId(SPLIT("s", "another-card"), CARD.id), false, "another card's id");
  assert.equal(misplacedBoardId("s\n\nBoard-Id: not a card id\n\nCo-Authored-By: x", CARD.id), false);
  assert.equal(misplacedBoardId(undefined, CARD.id), false);
});

test("a pushed tip with a misplaced Board-Id reads build with no sign-offs, says so in its evidence, and its builder's turn names the commit and the fix, not 'nothing pushed'", () => {
  const s = scratch();
  const message = SPLIT("#C1236 The visitor map");
  const old = s.onBranch("admin/c1236-demo-views-map", 10, message);
  s.sync();
  const st = cardState(CARD, s.repo([s.tip("admin/c1236-demo-views-map", old, 10, message)]), cfg, now);
  assert.equal(st.headSha12, old.slice(0, 12));
  assert.equal(st.phase, "build"); assert.deepEqual(st.signed, []);
  assert.equal(st.trailerMisplaced, true, "the evidence names the problem");
  const turns = turnsOf(CARD, st);
  assert.equal(turns[0].trailer, true); assert.equal(turns[0].sha, old.slice(0, 12));
  const { items } = dispatchItems({ cards: [{ id: CARD.id, num: CARD.num, status: "active", who: "Admin", turns }], agents: { Admin: { state: "idle", since: 0 } }, roster: ["Admin"], now: 10 ** 9 });
  const line = dispatchLine(items[0]);
  assert.ok(line.includes(DISPATCH_TRAILER_TEXT) && line.includes("last paragraph"), line);
  assert.ok(!line.includes("has nothing pushed"));
});

test("a tip with a real trailer is not flagged, and a WIP start push is not either", () => {
  const s = scratch();
  const good = s.onBranch("admin/c1236-demo-views-map", 10, ONE("#C1236 The visitor map"));
  s.sync();
  const st = cardState(CARD, s.repo([s.tip("admin/c1236-demo-views-map", good, 10, ONE("#C1236 The visitor map"))]), cfg, now);
  assert.equal(st.trailerMisplaced, undefined);
  assert.equal(turnsOf(CARD, st)[0].trailer, undefined);
  const wip = SPLIT("#C1236 WIP: branch pushed before the first edit");
  const w = s.onBranch("admin/c1236-wip", 11, wip);
  s.sync();
  const sw = cardState(CARD, s.repo([s.tip("admin/c1236-wip", w, 11, wip)]), cfg, now);
  assert.equal(sw.trailerMisplaced, undefined, "a start push is work in progress, not a mistake to chase");
});

test("a card re-cut on a second branch and shipped, its commits without a trailer and the old branch still on origin, is read from the commit the ship line cites: on main, signed, no 'nothing pushed'", () => {
  const s = scratch();
  const old = s.onBranch("admin/c1236-demo-views-map", 10, SPLIT("#C1236 The visitor map, first cut"));
  const cut = s.onBranch("admin/c1236-demo-map", 20, SPLIT("#C1236 The visitor map, re-cut"));
  s.sign(cut);
  const merged = s.ship("admin/c1236-demo-map", cut);
  s.g(["branch", "-qD", "admin/c1236-demo-map"]);
  s.sync();
  const repo = s.repo([s.tip("admin/c1236-demo-views-map", old, 10, SPLIT("#C1236 The visitor map, first cut"))], { shippedPattern: SHIPPED });
  const st = cardState(CARD, repo, cfg, now);
  assert.equal(st.onMain, true, "on main");
  assert.equal(st.headSha12, cut.slice(0, 12), "the commit that shipped, not the old branch's tip");
  assert.equal(st.headBranch, "main");
  assert.notEqual(st.phase, "build", "past build");
  assert.equal(st.trailerMisplaced, undefined, "nothing to chase once it is on main");
  assert.ok(!turnsOf(CARD, st).some((t) => t.phase === "build"), `no build turn: ${JSON.stringify(turnsOf(CARD, st))}`);
  assert.ok(merged);
});

test("the ship line is read only for a card whose tips lack its trailer, and only for a branch of that card that is on main", () => {
  // A tip that carries the card's own trailer is never overridden by a ship line.
  const s = scratch();
  const own = s.onBranch("admin/c1236-demo-views-map", 10, ONE("#C1236 The visitor map"));
  const other = s.onBranch("admin/c1236-demo-map", 20, SPLIT("#C1236 The visitor map, re-cut"));
  s.ship("admin/c1236-demo-map", other);
  s.sync();
  const repo = s.repo([s.tip("admin/c1236-demo-views-map", own, 10, ONE("#C1236 The visitor map"))], { shippedPattern: SHIPPED });
  assert.equal(cardState(CARD, repo, cfg, now).headSha12, own.slice(0, 12), "its own trailer wins");
  // A ship line that cites another card's branch is not this card's.
  const t = scratch();
  const mine = t.onBranch("admin/c1236-demo-views-map", 10, SPLIT("#C1236 The visitor map"));
  const theirs = t.onBranch("admin/c1300-something-else", 20, ONE("#C1300 Something else", "something-else"));
  t.ship("admin/c1300-something-else", theirs);
  t.sync();
  const st = cardState(CARD, t.repo([t.tip("admin/c1236-demo-views-map", mine, 10, SPLIT("#C1236 The visitor map"))], { shippedPattern: SHIPPED }), cfg, now);
  assert.equal(st.headSha12, mine.slice(0, 12)); assert.equal(st.onMain, false);
  // A cited sha that is no commit of main (or not a commit at all) is ignored.
  const u = scratch();
  const lone = u.onBranch("admin/c1236-demo-views-map", 10, SPLIT("#C1236 The visitor map"));
  // One that is no commit at all, and one that is a real commit of the card's own branch that never reached main.
  u.g(["checkout", "-q", "main"]); u.g(["commit", "--allow-empty", "-qm", "v1.0.1: admin/c1236-demo-map@deadbeef0"]);
  const unmerged = u.onBranch("admin/c1236-demo-map", 30, SPLIT("#C1236 The visitor map, re-cut, never merged"));
  u.g(["checkout", "-q", "main"]); u.g(["commit", "--allow-empty", "-qm", `v1.0.2: admin/c1236-demo-map@${unmerged.slice(0, 8)}`]);
  u.sync();
  const su = cardState(CARD, u.repo([u.tip("admin/c1236-demo-views-map", lone, 10, SPLIT("#C1236 The visitor map"))], { shippedPattern: SHIPPED }), cfg, now);
  assert.equal(su.headSha12, lone.slice(0, 12)); assert.equal(su.onMain, false);
});
