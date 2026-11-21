// #C1406 (the owner, 2026-11-20 about 9:20 pm MT, two screenshots): a reviewer's FINDINGS or RISKS note on the card's current tip sends it back, and a newer tip with its READY puts it back in review, both
// read from git with no hand step; and the review counters are a per-tip record (the open findings on the current tip), never an older tip's. (1) #C1391 read STUCK at the checker with 0 bugs after the findings;
// (2) #C1405 read SENT BACK with "1 security fix" after the fix tip and its READY, the RISKS being on the old tip. Real git for the probe half, the store for the rest; fictional names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { cardWriteRefusal } from "../worker/board-rules.mjs";
import { reading, tileAt } from "../worker/reading.mjs";
import { createCard, writeEvidence } from "../worker/board-store.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const NOW = 1_800_000_000_000, A = "a".repeat(12), B = "b".repeat(12);
const rd = (head, extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: head, headSha: head.repeat(4).slice(0, 40), signed: [], onMain: false, ...extra });
const CARD = { id: "a-card", num: 5, owner_role: "Builder", repo: "flight-board" };
const fresh = async () => { const db = makeDb(); await createCard(db, NOW, "Manager", { id: "a-card", title: "A card", owner_role: "Builder" }); return db; };
const evidenceOf = async (db) => JSON.parse((await db.prepare("SELECT value FROM evidence WHERE key = 'cards.a-card'").first()).value);
const issuesOf = async (db) => { const r = await db.prepare("SELECT issues FROM cards WHERE id = 'a-card'").first(); return r.issues ? JSON.parse(r.issues) : null; };
const read = (e) => reading(CARD, e, [], {}, {}, NOW + 9e6, {});

test("this exact #C1405 sequence: RISKS on the tip sends it back with no hand step; the fix tip with its READY puts it back in review, and the count follows the tip", async () => {
  const db = await fresh();
  // the card is at the checker and security on tip A
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd(A, { tipIssues: {} }));
  assert.notEqual(read(await evidenceOf(db)).state, "rework");
  // Security's RISKS lands on tip A: the card is sent back, with its owner, and no reason is asked of anyone
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd(A, { findings: ["security"], issueCounts: { security: 1 }, tipIssues: { security: 1 } }));
  let e = await evidenceOf(db), r = read(e);
  assert.equal("rework" in e, false, "no flag waits for a reason: the findings on the tip are the reason");
  assert.equal(r.state, "rework");
  assert.equal(r.with, "Builder", "the owner's turn");
  assert.deepEqual(await issuesOf(db), { security: 1 }, "the count comes from the note");
  assert.equal(cardWriteRefusal({ id: "a-card", next_note: "fixing" }, e), null, "no \"rework reason missing\" refusal for the builder's own writes");
  // the builder's fix: a start push (a newer tip, no READY yet) still has the card with its owner
  await writeEvidence(db, NOW + 3e3, "probe", "cards.a-card", { ...rd(B, { lit: ["build"], phase: "build", stackHold: true, issueCounts: { security: 1 }, tipIssues: {} }) });
  assert.equal(read(await evidenceOf(db)).with, "Builder");
  // the fix tip READY (stack-ready written): back in review, waiting for the re-sign, the sent-back mark gone, the count of the old tip gone
  await writeEvidence(db, NOW + 4e3, "probe", "cards.a-card", rd(B, { issueCounts: { security: 1 }, tipIssues: {} }));
  e = await evidenceOf(db); r = read(e);
  assert.equal("rework" in e, false, "the sent-back flag is gone");
  assert.notEqual(r.state, "rework", `back in review (${r.state}, ${r.why})`);
  assert.equal(r.phase, "checker");
  assert.deepEqual(await issuesOf(db) ?? {}, {}, "the old tip's finding no longer counts: no \"1 security fix\"");
});

test("each transition in one probe run: findings set rework, a note that later reads PASS ends it, a newer READY tip clears a flag a step back had set", async () => {
  const db = await fresh();
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd(A, { findings: ["checker"], tipIssues: { bugs: 2 } }));
  assert.equal(read(await evidenceOf(db)).state, "rework");
  assert.deepEqual(await issuesOf(db), { bugs: 2 });
  // the reviewer re-signs the same tip: the note now reads PASS, nothing is open on the tip
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd(A, { signed: ["checker"], tipIssues: {} }));
  assert.notEqual(read(await evidenceOf(db)).state, "rework");
  assert.deepEqual(await issuesOf(db) ?? {}, {}, "an open count that is closed reads 0");
  // a step back the Worker flags (findings on the old tip, the builder's newer tip read at build) is cleared when that tip reads at review again, with no new tip needed
  const db2 = await fresh();
  await writeEvidence(db2, NOW + 1e3, "probe", "cards.a-card", rd(A, { findings: ["checker"], tipIssues: { bugs: 1 } }));
  await writeEvidence(db2, NOW + 2e3, "probe", "cards.a-card", rd(B, { lit: ["build"], phase: "build", stackHold: true, tipIssues: {} }));
  assert.equal((await evidenceOf(db2)).rework, true, "a newer tip still at build after findings is the builder's, flagged until its reason");
  await writeEvidence(db2, NOW + 3e3, "probe", "cards.a-card", rd(B, { tipIssues: {} }));
  assert.equal("rework" in (await evidenceOf(db2)), false, "the same tip read at the checker again (its READY declared) clears the flag");
});

// Security's L2 on 99332612: the clearing needs "no findings of its own on the tip read at review".
test("must still allow: a card with the sent-back flag that is read at review WITH findings on its tip keeps the flag", async () => {
  const db = await fresh();
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd(A, { findings: ["checker"], tipIssues: { bugs: 1 } }));
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd(B, { lit: ["build"], phase: "build", stackHold: true, tipIssues: {} }));
  assert.equal((await evidenceOf(db)).rework, true, "a newer tip still at build after findings is flagged");
  await writeEvidence(db, NOW + 3e3, "probe", "cards.a-card", rd(B, { findings: ["checker"], tipIssues: { bugs: 1 } }));
  assert.equal((await evidenceOf(db)).rework, true, "read at the checker with findings of its own: still sent back, the flag stays");
});

test("must still allow: a reading from a probe with no tipIssues keeps the old rules (counts only rise inside a range)", async () => {
  const db = await fresh();
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd(A, { issueCounts: { bugs: 2 } }));
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd(B, { issueCounts: { bugs: 1 } }));
  assert.deepEqual(await issuesOf(db), { bugs: 2 });
});

test("a reviewer with an open claim on the card holds it (the crew row reads the claim), on the current tip or an older one", () => {
  const e = rd(B);
  const claim = (sha) => [{ card_id: "a-card", sha, checker: "Checker 2", released_at: null }];
  assert.equal(read({ ...e }).with, "Checker", "no claim: the lane's role");
  assert.equal(reading(CARD, e, claim(e.headSha), {}, {}, NOW, {}).with, "Checker 2");
  assert.equal(reading(CARD, e, claim("c".repeat(40)), {}, {}, NOW, {}).with, "Checker 2", "a claim taken on the older tip still holds the card");
  assert.equal(reading(CARD, e, [{ ...claim(e.headSha)[0], released_at: 5 }], {}, {}, NOW, {}).with, "Checker", "a released claim holds nothing");
});

// ---- the probe's half, real git: tipIssues counts the open findings on the current tip only ----
const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-tip-")), work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]); execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (name, msg, t, first) => { if (first) g(["checkout", "-qb", name]); else g(["checkout", "-q", name]); at = T0 + t; appendFileSync(join(work, `${name}.md`), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]); return sha; };
  const note = (sha, who, text, t) => { at = T0 + t; g(["notes", `--ref=${NOTES[who]}`, "add", "-f", "-m", text, sha]); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "-f", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); };
  const tips = (name, sha, t, msg) => [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: `origin/${name}`, sha, at: (T0 + t) * 1000, message: msg }];
  const repo = (extra = {}) => ({ git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, tips: [], ...extra });
  return { commit, note, sync, tips, repo };
}
const probe = (s, id, sha, t, msg) => cardState({ id, num: 820, level: "Full", phase: "plan" }, s.repo({ tips: s.tips(id, sha, t, msg) }), cfg, T0 * 1000);

test("the probe counts the open findings of the current tip alone: the old tip's RISKS stop counting at the fix tip, and an empty tip says {}", () => {
  const s = scratch(), msg = "Work\n\nBoard-Id: card-c";
  const old = s.commit("card-c", msg, 10, true);
  s.note(old, "security", "RISKS Quick\nS1 MEDIUM a.mjs:1 slow", 30); s.sync();
  const first = probe(s, "card-c", old, 10, msg);
  assert.deepEqual(first.tipIssues, { security: 1 });
  assert.deepEqual(stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { "card-c": first }, agents: {} }), []);
  const fix = s.commit("card-c", msg, 60, false); s.sync();
  const second = probe(s, "card-c", fix, 60, msg);
  assert.deepEqual(second.tipIssues, {}, "nothing is open on the fix tip");
  assert.deepEqual(second.issueCounts, { security: 1 }, "the branch-wide sum (the unexplained hold's) is unchanged");
  s.note(fix, "security", "SECURE Quick", 80); s.sync();
  assert.deepEqual(probe(s, "card-c", fix, 60, msg).tipIssues, {});
});

// Checker 2's L1 on 99332612 (q6, q7): the covering tip's findings count, and a notes read that failed leaves the count out (never a 0 that would clear a real one).
test("tipIssues counts the covering tip's findings too, and leaves the field out when a notes read failed", () => {
  const s = scratch(), msg = "Work\n\nBoard-Id: card-d";
  const mine = s.commit("card-d", msg, 10, true), top = s.commit("card-top", "Top\n\nBoard-Id: card-top", 20, true);
  s.note(top, "checker", "FINDINGS Quick\nF1 MEDIUM a.mjs:1 wrong", 40); s.sync();
  const card = { id: "card-d", num: 821, level: "Full", phase: "plan" };
  const withCover = cardState(card, s.repo({ tips: s.tips("card-d", mine, 10, msg) }), cfg, T0 * 1000, { cover: top });
  assert.deepEqual(withCover.tipIssues, { bugs: 1 }, "the stack tip's FINDINGS count for the card read under it");
  assert.deepEqual(cardState(card, s.repo({ tips: s.tips("card-d", mine, 10, msg) }), cfg, T0 * 1000).tipIssues, {}, "with no cover nothing is open on its own tip");
  const broken = s.repo({ tips: s.tips("card-d", mine, 10, msg) }), git = broken.git;
  broken.git = (args) => { if (args[0] === "notes" && args.includes("show")) { const e = new Error("fatal: bad object"); e.status = 128; throw e; } return git(args); };
  const failed = cardState(card, broken, cfg, T0 * 1000);
  assert.equal("tipIssues" in failed, false, "no count is claimed from notes that could not be read");
  assert.ok(Array.isArray(failed.unread) && failed.unread.includes("notes"), "the read failure is the card's own unread notes");
});

// Checker 2's L1 (q5): a flag an older reading set while the card sat at review clears only on a newer tip, never on the same tip read again.
test("must still allow: a sent-back flag set while the card sat at review stays on the same tip and clears on a newer one", async () => {
  const db = await fresh();
  await writeEvidence(db, NOW + 1e3, "probe", "cards.a-card", rd(A, { tipIssues: {} }));
  const row = await evidenceOf(db);
  await db.prepare("UPDATE evidence SET value = ? WHERE key = 'cards.a-card'").bind(JSON.stringify({ ...row, rework: true })).run();
  await writeEvidence(db, NOW + 2e3, "probe", "cards.a-card", rd(A, { tipIssues: {} }));
  assert.equal((await evidenceOf(db)).rework, true, "the same tip read at the checker again: the flag stays");
  await writeEvidence(db, NOW + 3e3, "probe", "cards.a-card", rd(B, { tipIssues: {} }));
  assert.equal("rework" in (await evidenceOf(db)), false, "a newer tip read at the checker: back in review");
});

// Checker 2's F1 and F2 on 99332612.
test("a card sent back by findings reads at BUILD with its owner and says why in the lane's words; the lane's own phase is kept", () => {
  const sent = (lane, phase) => reading({ ...CARD, owner_role: "Builder" }, { ...rd(A), lit: [phase], phase, findings: [lane] }, [], {}, {}, NOW, {});
  const c = sent("checker", "checker");
  assert.deepEqual([c.state, c.phase, c.with, c.reason, c.reviewPhase], ["rework", "build", "Builder", "review findings", "checker"]);
  assert.match(c.why, /review findings/);
  assert.equal(tileAt(c, "build"), "wait", "the BUILD tile is the lit one (the owner's turn: yellow, nobody on it yet)");
  assert.equal(tileAt(c, "checker"), "future", "the review lanes are not reached again");
  const sec = sent("security", "security");
  assert.deepEqual([sec.state, sec.phase, sec.with, sec.reason, sec.reviewPhase], ["rework", "build", "Builder", "security finding", "security"]);
  assert.match(sec.why, /security finding/);
  assert.notEqual(sec.why, c.why, "the why names the lane");
  assert.equal(sent("language", "language").reason, "review findings");
  const working = reading({ ...CARD, owner_role: "Builder" }, { ...rd(A), findings: ["checker"] }, [], { Builder: { state: "working", card: "a-card" } }, {}, NOW, {});
  assert.equal(tileAt(working, "build"), "working", "with the owner on it the BUILD tile is the blue working one");
});

test("a Checker claim left open on an older tip holds the card at the checker only; at language, design and security only a claim on the current tip counts", () => {
  const old = "c".repeat(40), claims = (sha) => [{ card_id: "a-card", sha, checker: "Checker 2", released_at: null }];
  for (const [phase, lane] of [["language", "Linguist"], ["design", "Designer"], ["security", "Security"]]) {
    const e = { ...rd(A), lit: [phase], phase };
    assert.equal(reading(CARD, e, [], {}, {}, NOW, {}).with, lane, `${phase}: no claim reads the lane`);
    assert.equal(reading(CARD, e, claims(old), {}, {}, NOW, {}).with, lane, `${phase}: an older tip's claim holds nothing`);
    assert.equal(reading(CARD, e, claims(e.headSha), {}, {}, NOW, {}).with, "Checker 2", `${phase}: a claim on the current tip holds it`);
  }
  assert.equal(reading(CARD, rd(A), claims(old), {}, {}, NOW, {}).with, "Checker 2", "at the checker an older tip's claim still holds it");
});

// Security's L1 on 99332612: tipIssues is the probe's privacy check (only counts leave the Mac, never free text); the schema, not the Worker alone, refuses anything else, and never echoes it.
test("the schema refuses a tipIssues that is not counts: an unknown kind, free text, 0, 100, a non-integer, a list; and echoes none of it", () => {
  const base = { num: 820, phase: "checker", headSha12: "a".repeat(12), signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: T0 * 1000 };
  const check = (tipIssues) => stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { "card-c": { ...base, tipIssues } }, agents: {} });
  assert.deepEqual(check({}), [], "no open findings fits");
  assert.deepEqual(check({ bugs: 2, security: 1, language: 99, design: 1 }), [], "counts of the four kinds fit");
  for (const bad of [{ typo: 1 }, { bugs: "SECRET-TEXT-9" }, { bugs: 0 }, { bugs: 100 }, { bugs: 1.5 }, { bugs: -1 }, { "SECRET-TEXT-9": 1 }, [], ["bugs"], "SECRET-TEXT-9", 5, null]) {
    const errors = check(bad);
    assert.ok(errors.length > 0, `refused: ${JSON.stringify(bad)}`);
    assert.ok(!JSON.stringify(errors).includes("SECRET-TEXT-9"), `not echoed: ${JSON.stringify(bad)}`);
  }
});
