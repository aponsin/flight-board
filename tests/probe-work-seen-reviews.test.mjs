// #C731 B4b slice 3: the probe reads three more of the Collector's readings for the old page: reviews ({ phase: ms }, when each signed
// review was signed, from the notes ref's history), workSeen (a commit on main cites a card with no branch left) and shippedAt (a ship
// commit on main citing it), and the store's compat view passes them to derived/all. Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { derivedDoc } from "../worker/compat-view.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const SHIP = "^v(\\d+\\.\\d+\\.\\d+)\\b";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-seen-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const branch = (name, msg, t) => { g(["checkout", "-qb", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]); return sha; };
  const onMain = (msg, t) => { at = T0 + t; g(["commit", "--allow-empty", "-qm", msg]); };
  const sign = (sha, who, t) => { at = T0 + t; g(["notes", `--ref=${NOTES[who]}`, "add", "-m", "PASS", sha]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tipsOf = (name, sha, t, msg) => [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: `origin/${name}`, sha, at: (T0 + t) * 1000, message: msg }];
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, tips: [], ...extra });
  return { g, branch, onMain, sign, sync, tipsOf, repo };
}
const fits = (id, st) => stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { [id]: st }, agents: {} });

test("reviews: each signed review at the time its note was written, and none for an unsigned tip", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-r";
  const sha = s.branch("card-r", msg, 10); s.sign(sha, "checker", 30); s.sign(sha, "security", 50); s.sync();
  const st = cardState({ id: "card-r", num: 801, level: "Full", phase: "plan" }, s.repo({ tips: s.tipsOf("card-r", sha, 10, msg) }), cfg, T0 * 1000);
  assert.deepEqual(st.reviews, { checker: (T0 + 30) * 1000, security: (T0 + 50) * 1000 });
  assert.deepEqual(fits("card-r", st), []);
  const s2 = scratch();
  const sha2 = s2.branch("card-q", "Some work", 10); s2.sync();
  const none = cardState({ id: "card-q", num: 802, level: "Full", phase: "plan" }, s2.repo({ tips: s2.tipsOf("card-q", sha2, 10, "Some work") }), cfg, T0 * 1000);
  assert.ok(!("reviews" in none));
});

test("reviews: a note the history cannot date takes the READY commit's time, never the present", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-d";
  const sha = s.branch("card-d", msg, 10); s.sign(sha, "checker", 30); s.sync();
  const real = s.repo({ tips: s.tipsOf("card-d", sha, 10, msg) });
  const noDates = { ...real, git: (args) => { if (args[0] === "log" && args.includes("refs/notes/checker")) throw new Error("shallow"); return real.git(args); } };
  const st = cardState({ id: "card-d", num: 803, level: "Full", phase: "plan" }, noDates, cfg, T0 * 1000);
  assert.deepEqual(st.reviews, { checker: (T0 + 10) * 1000 });
});

test("workSeen and shippedAt: a commit on main that cites the card, a ship commit that cites it, and no other card's", () => {
  const s = scratch();
  s.onMain("#C810: squashed work", 5);
  s.onMain("v1.2.3: build/other@abcdef12 (#C811)", 6);
  s.onMain("v1.2.4: build/x@abcdef13 (#C811)", 9);
  s.onMain("unrelated change for #C8110 and #C8", 12);
  s.sync();
  const repo = s.repo({ versionPattern: SHIP });
  const seen = cardState({ id: "card-sq", num: 810, level: "Full", phase: "plan" }, repo, cfg, T0 * 1000);
  assert.equal(seen.workSeen, true); assert.ok(!("shippedAt" in seen));
  const shipped = cardState({ id: "card-sh", num: 811, level: "Full", phase: "plan" }, repo, cfg, T0 * 1000);
  assert.equal(shipped.workSeen, true); assert.equal(shipped.shippedAt, (T0 + 9) * 1000, "the newest ship commit");
  assert.deepEqual(fits("card-sh", shipped), []);
  const other = cardState({ id: "card-ot", num: 81, level: "Full", phase: "plan" }, repo, cfg, T0 * 1000);
  assert.ok(!("workSeen" in other), "#C81 is not #C810, #C811 or #C8110");
  const noPattern = cardState({ id: "card-sh", num: 811, level: "Full", phase: "plan" }, s.repo(), cfg, T0 * 1000);
  assert.equal(noPattern.workSeen, true); assert.ok(!("shippedAt" in noPattern), "no versionPattern, no ship commit");
});

// Checker on 15ce85c: a note or ship commit dated outside the plan's 2020-2100 range (a wrong clock, a rewritten date) is dropped, so one
// bad date cannot fail the whole state build.
test("a review note or a ship commit dated outside 2020-2100 gives no review or shippedAt, and the state still fits", () => {
  // git itself refuses a date past 2^32 seconds, so the repository is real and the date is rewritten by a stub: the note's commit
  // time, and the time of the "v2.0.0" commit on main.
  const redated = (repo, ct) => ({ ...repo, git: (args) => {
    const out = repo.git(args);
    if (args[0] === "log" && args.includes("refs/notes/checker")) return `${ct}\n`;
    if (args[0] === "log" && args.includes("--first-parent")) return out.split("\n").map((l) => (l.includes("v2.0.0:") ? l.split("\x1f").map((f, i) => (i === 1 ? String(ct) : f)).join("\x1f") : l)).join("\n");
    return out;
  } });
  for (const ct of [631_152_000, 4_200_000_000]) {
    const s = scratch();
    const msg = "Work\n\nBoard-Id: card-t";
    const sha = s.branch("card-t", msg, 10); s.sign(sha, "checker", 30); s.sync();
    const st = cardState({ id: "card-t", num: 830, level: "Full", phase: "plan" }, redated(s.repo({ tips: s.tipsOf("card-t", sha, 10, msg) }), ct), cfg, T0 * 1000);
    assert.ok(!("reviews" in st), `a note dated ${ct} is no review`);
    assert.deepEqual(fits("card-t", st), []);
    const m = scratch();
    m.onMain("v2.0.0: build/x@abcdef12 (#C831)", 10); m.onMain("v2.0.1: build/x@abcdef13 (#C831)", 20); m.sync();
    const sh = cardState({ id: "card-u", num: 831, level: "Full", phase: "plan" }, redated(m.repo({ versionPattern: SHIP }), ct), cfg, T0 * 1000);
    assert.equal(sh.workSeen, true); assert.equal(sh.shippedAt, (T0 + 20) * 1000, "only the commit with a date in range counts");
    assert.deepEqual(fits("card-u", sh), []);
    const only = scratch();
    only.onMain("v2.0.0: build/x@abcdef12 (#C832)", 10); only.sync();
    const one = cardState({ id: "card-v", num: 832, level: "Full", phase: "plan" }, redated(only.repo({ versionPattern: SHIP }), ct), cfg, T0 * 1000);
    assert.equal(one.workSeen, true); assert.ok(!("shippedAt" in one)); assert.deepEqual(fits("card-v", one), []);
  }
});

test("workSeen is not read for a card with a head, and a git failure reads as nothing", () => {
  const s = scratch();
  s.onMain("#C820: work", 5);
  const msg = "Work\n\nBoard-Id: card-h";
  const sha = s.branch("card-h", msg, 10); s.sync();
  const withHead = cardState({ id: "card-h", num: 820, level: "Full", phase: "plan" }, s.repo({ tips: s.tipsOf("card-h", sha, 10, msg) }), cfg, T0 * 1000);
  assert.ok(!("workSeen" in withHead));
  const broken = cardState({ id: "card-z", num: 820, level: "Full", phase: "plan" }, { ...s.repo(), git: () => { throw new Error("no git"); } }, cfg, T0 * 1000);
  assert.ok(!("workSeen" in broken));
  for (const bad of [0, 1_000_001, 1.5, null]) assert.ok(!("workSeen" in cardState({ id: "card-z", num: bad, level: "Full", phase: "plan" }, s.repo(), cfg, T0 * 1000)), String(bad));
});

test("the plan: workSeen only true, shippedAt a time, reviews one to ten phases with times; pickState copies reviews", () => {
  const base = { num: 1, phase: "build", headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: T0 * 1000 };
  const t = (c) => ({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { x: { ...base, ...c } }, agents: {} });
  assert.deepEqual(stateErrors(t({ workSeen: true, shippedAt: (T0 + 1) * 1000, reviews: { checker: (T0 + 2) * 1000 } })), []);
  for (const bad of [{ workSeen: false }, { workSeen: "yes" }, { shippedAt: 5 }, { shippedAt: 1.5e12 + 0.5 }, { reviews: {} }, { reviews: { Checker: (T0 + 2) * 1000 } }, { reviews: { checker: 7 } }, { reviews: [] }, { reviews: { checker: "x" } },
    { reviews: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`phase${String.fromCharCode(97 + i)}`, (T0 + 2) * 1000])) }])
    assert.ok(stateErrors(t(bad)).length, JSON.stringify(bad));
  const input = t({ reviews: { checker: (T0 + 2) * 1000 } });
  const out = pickState(input);
  assert.deepEqual(out.cards.x.reviews, { checker: (T0 + 2) * 1000 });
  assert.notEqual(out.cards.x.reviews, input.cards.x.reviews, "a copy, not the input's object");
});

test("derived/all carries workSeen, shippedAt and reviews, and drops what is not a time or true", () => {
  const view = { now: 5, evidence: {
    "cards.a": { readAt: 1, value: { phase: "ship", headSha12: null, workSeen: true, shippedAt: 1_790_000_009_000, reviews: { checker: 1_790_000_030_000 } } },
    "cards.b": { readAt: 1, value: { phase: "build", headSha12: null, workSeen: false, shippedAt: "x", reviews: { checker: "later", security: 1_790_000_050_000 } } },
    "cards.c": { readAt: 1, value: { phase: "plan", headSha12: null, reviews: {} } },
  } };
  const d = derivedDoc(view).cards;
  assert.equal(d.a.workSeen, true); assert.equal(d.a.shippedAt, 1_790_000_009_000); assert.deepEqual(d.a.reviews, { checker: 1_790_000_030_000 });
  assert.ok(!("workSeen" in d.b) && !("shippedAt" in d.b)); assert.deepEqual(d.b.reviews, { security: 1_790_000_050_000 });
  assert.ok(!("workSeen" in d.c) && !("reviews" in d.c));
});
