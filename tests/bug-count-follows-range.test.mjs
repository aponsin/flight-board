// #C1397: a card's counters follow its range. Within one range they only rise (#C1114); when the range changes (the probe's issueBase, the merge-base of main and the tip,
// differs from the one in the card's previous reading) the review kinds are set to the new range's counts, so findings of commits no longer between main and the tip stop counting.
// `owner` is typed and stays. Fictional card and names; the probe half uses real git.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { raisedIssues } from "../worker/board-rules.mjs";
import { createCard, writeEvidence } from "../worker/board-store.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";

const NOW = 1_800_000_000_000;
const BASE_A = "a".repeat(40), BASE_B = "b".repeat(40);
const rd = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, ...extra });
const issuesOf = async (db) => { const r = await db.prepare("SELECT issues FROM cards WHERE id = 'a-card'").first(); return r.issues ? JSON.parse(r.issues) : null; };
const fresh = async (issues) => { const db = makeDb(); await createCard(db, NOW, "Manager", { id: "a-card", title: "A card", owner_role: "Builder", ...(issues ? { issues } : {}) }); return db; };

test("raisedIssues with replace sets the four review kinds, drops the ones the range has none of, and never touches owner or release", () => {
  assert.deepEqual(raisedIssues({ bugs: 3, security: 1, owner: 2, release: 1 }, { bugs: 1 }, true), { bugs: 1, owner: 2, release: 1 });
  assert.deepEqual(raisedIssues({ bugs: 1, owner: 2 }, {}, true), { owner: 2 });
  assert.equal(raisedIssues({ bugs: 1 }, { bugs: 1 }, true), null, "nothing differs");
});

test("(a) the same range: the counter only rises", async () => {
  const db = await fresh();
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd({ issueBase: BASE_A, issueCounts: { bugs: 2 } }));
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd({ headSha12: "bbbbbbbbbbbb", issueBase: BASE_A, issueCounts: { bugs: 1 } }));
  assert.deepEqual(await issuesOf(db), { bugs: 2 }, "a smaller reading in the same range never lowers");
  await writeEvidence(db, NOW + 3e3, "probe", "cards.a-card", rd({ headSha12: "cccccccccccc", signed: ["checker"], issueBase: BASE_A }));
  assert.deepEqual(await issuesOf(db), { bugs: 2 }, "a later PASS (no counts) in the same range keeps the earlier round");
  await writeEvidence(db, NOW + 4e3, "probe", "cards.a-card", rd({ headSha12: "dddddddddddd", issueBase: BASE_A, issueCounts: { bugs: 3, design: 1 } }));
  assert.deepEqual(await issuesOf(db), { bugs: 3, design: 1 });
});

test("(b) the range changed with fewer findings: the review kinds go down to the probe's numbers and owner stays", async () => {
  const db = await fresh({ owner: 2 });
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd({ issueBase: BASE_A, issueCounts: { bugs: 1, security: 2 } }));
  assert.deepEqual(await issuesOf(db), { owner: 2, bugs: 1, security: 2 });
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd({ headSha12: "bbbbbbbbbbbb", issueBase: BASE_B, issueCounts: { security: 1 } }));
  assert.deepEqual(await issuesOf(db), { owner: 2, security: 1 });
});

test("(c) the range changed to one with no findings: the review kinds are cleared, owner stays", async () => {
  const db = await fresh({ owner: 1 });
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd({ issueBase: BASE_A, issueCounts: { bugs: 1 } }));
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd({ headSha12: "bbbbbbbbbbbb", issueBase: BASE_B }));
  assert.deepEqual(await issuesOf(db), { owner: 1 });
});

test("(d) no previous issueBase: the old raise-only behaviour; the next reading with a changed base then follows the range", async () => {
  const db = await fresh();
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd({ issueCounts: { bugs: 2 } }));
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd({ headSha12: "bbbbbbbbbbbb", issueBase: BASE_A, issueCounts: { bugs: 1 } }));
  assert.deepEqual(await issuesOf(db), { bugs: 2 }, "first reading carrying a base does not lower");
  await writeEvidence(db, NOW + 3e3, "probe", "cards.a-card", rd({ headSha12: "cccccccccccc", issueBase: BASE_B }));
  assert.deepEqual(await issuesOf(db), {},"now both bases exist and differ: cleared");
});

// (e) the probe's half, real git.
const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-range-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const mainSha = g(["rev-parse", "HEAD"]).trim();
  const commit = (name, msg, t, first) => { if (first) g(["checkout", "-qb", name]); else g(["checkout", "-q", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]); return sha; };
  const note = (sha, text, t) => { at = T0 + t; g(["notes", `--ref=${NOTES.checker}`, "add", "-f", "-m", text, sha]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "-f", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tips = (name, sha, t, msg) => [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: `origin/${name}`, sha, at: (T0 + t) * 1000, message: msg }];
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, tips: [], ...extra });
  return { g, commit, note, sync, tips, repo, mainSha };
}
const read = (s, id, sha, t, msg) => cardState({ id, num: 820, level: "Full", phase: "plan" }, s.repo({ tips: s.tips(id, sha, t, msg) }), cfg, T0 * 1000);

test("(f) a rev-list that fails sends no issueBase and no counts, so a base change cannot wipe the counters", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-f";
  const sha = s.commit("card-f", msg, 10, true);
  s.note(sha, "FINDINGS Full\nF1 LOW a.mjs:1 one", 30); s.sync();
  const asRead = (git) => cardState({ id: "card-f", num: 821, level: "Full", phase: "plan" }, s.repo({ git, tips: s.tips("card-f", sha, 10, msg) }), cfg, T0 * 1000);
  assert.equal(asRead((args) => s.g(args)).issueBase, s.mainSha, "the control: it is sent when the range is listed");
  const failing = (args) => { if (args[0] === "rev-list" && String(args[1]).startsWith("--max-count=60")) { const e = new Error("fatal: bad revision"); e.status = 128; throw e; } return s.g(args); };
  const st = asRead(failing);
  assert.ok(!("issueBase" in st), "no base on a failed listing");
  assert.ok(!("issueCounts" in st));
});

test("(e) the probe's card evidence carries issueBase, the merge-base of main and the tip, and follows main when the base lands", () => {
  const s = scratch();
  const msg = "Work\n\nBoard-Id: card-r";
  const sha = s.commit("card-r", msg, 10, true);
  s.note(sha, "FINDINGS Full\nF1 LOW a.mjs:1 one", 30); s.sync();
  const st = read(s, "card-r", sha, 10, msg);
  assert.equal(st.issueBase, s.mainSha);
  assert.deepEqual(st.issueCounts, { bugs: 1 });
  const wrap = { v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { "card-r": st }, agents: {} };
  assert.deepEqual(stateErrors(wrap), []);
  assert.equal(pickState(wrap).cards["card-r"].issueBase, s.mainSha, "pickState carries it");
  // The first commit lands on main (fast-forward): the range is now empty-of-it and the base moves; the findings no longer sit between main and the tip.
  const sha2 = s.commit("card-r", msg, 60, false); s.sync();
  s.g(["merge", "-q", "--ff-only", sha]); s.g(["push", "-q", "origin", "main"]); s.g(["fetch", "-q", "--prune", "origin"]);
  const st2 = read(s, "card-r", sha2, 60, msg);
  assert.equal(st2.issueBase, sha);
  assert.ok(!("issueCounts" in st2), "no finding between the new base and the tip");
});
