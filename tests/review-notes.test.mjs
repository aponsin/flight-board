// #C671: reviews come from the sign-off notes. The probe's derived card carries reviews { phase: ms } (the note's time) for every
// review signed on the head; the page counts one as an end step the agent did not log, and the gate counts it for a ship step
// (tests/step-guards.test.mjs). Fictional cards.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { signedTimes, signedPhases, factsFor } from "../collector/facts.mjs";
import { derivePhase } from "../collector/derive.mjs";
import { cardState, remoteTips } from "../collector/state.mjs";
import { remoteHeads } from "../collector/facts.mjs";
import { underLive } from "../collector/collect.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { loadNames } from "./harness.mjs";

const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", collector: { repoPath: "/x", notes: NOTES } });
const at = (s) => Math.floor(Date.UTC(2030, 0, 1, 4, 0, 0) / 1000) + s; // seconds

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-notes-")), env = (t) => ({ ...process.env, GIT_COMMITTER_DATE: `${t} +0000`, GIT_AUTHOR_DATE: `${t} +0000` });
  const git = (args, t = at(0)) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env(t) });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"], at(0));
  git(["switch", "-q", "-c", "work-x"]); git(["commit", "-q", "--allow-empty", "-m", "work\n\nBoard-Id: work-x"], at(10));
  const sha = git(["rev-parse", "HEAD"]).trim();
  return { git, sha, dir };
}

test("signedTimes: each sign-off is dated by the notes ref's own history; an unsigned phase has no time", () => {
  const { git, sha } = scratch();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", sha], at(100));
  git(["notes", "--ref=refs/notes/security", "add", "-m", "SECURE", sha], at(250));
  const signed = signedPhases(git, sha, NOTES);
  assert.deepEqual([...signed].sort(), ["checker", "security"]);
  assert.deepEqual(signedTimes(git, sha, NOTES, signed, 7), { checker: at(100) * 1000, security: at(250) * 1000 });
  assert.deepEqual(signedTimes(git, sha, NOTES, new Set(["checker"]), 7), { checker: at(100) * 1000 }, "only the phases asked for");
  assert.deepEqual(signedTimes(git, sha, NOTES, new Set(), 7), {});
});

// #C852 (Checker): a note that starts FINDINGS is the review sending the commit back, not a sign-off, here as in the probe.
test("signedPhases: a FINDINGS note is no sign-off (a leading space is the same); a PASS or another word still is", () => {
  const { git, sha } = scratch();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "FINDINGS two bugs", sha], at(100));
  git(["notes", "--ref=refs/notes/security", "add", "-m", "SECURE", sha], at(120));
  assert.deepEqual([...signedPhases(git, sha, NOTES)], ["security"]);
  git(["notes", "--ref=refs/notes/security", "add", "-f", "-m", "  FINDINGS the lot", sha], at(130));
  assert.deepEqual([...signedPhases(git, sha, NOTES)], []);
  git(["notes", "--ref=refs/notes/checker", "add", "-f", "-m", "PASS Quick", sha], at(140));
  assert.deepEqual([...signedPhases(git, sha, NOTES)], ["checker"], "re-signed PASS counts");
});

test("signedTimes: a note re-signed later takes the later time; another commit's note does not move it", () => {
  const { git, sha } = scratch();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", sha], at(100));
  const base = git(["rev-parse", "main"]).trim();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS other", base], at(900));
  assert.equal(signedTimes(git, sha, NOTES, new Set(["checker"]), 7).checker, at(100) * 1000, "the other note was written later and is not this one's");
  git(["notes", "--ref=refs/notes/checker", "add", "-f", "-m", "PASS again", sha], at(1500));
  assert.equal(signedTimes(git, sha, NOTES, new Set(["checker"]), 7).checker, at(1500) * 1000);
});

// A notes ref fans its tree out as it grows (<aa>/<rest>, then <aa>/<bb>/<rest>); a note there is dated the same way.
function fanned(git, dir, sha, ref, levels, t) {
  const path = levels === 1 ? `${sha.slice(0, 2)}/${sha.slice(2)}` : `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha.slice(4)}`;
  const msg = "fanned";
  const input = `commit ${ref}\ncommitter t <t@t> ${t} +0000\ndata ${msg.length}\n${msg}\nM 100644 inline ${path}\ndata 5\nPASS\n\n`;
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input });
}
test("signedTimes: a note in a fanned-out notes tree (one or two levels) is dated like any other", () => {
  for (const levels of [1, 2]) {
    const { git, sha, dir } = scratch();
    fanned(git, dir, sha, "refs/notes/checker", levels, at(777));
    assert.deepEqual([...signedPhases(git, sha, NOTES)], ["checker"], `git finds the note at ${levels} level(s)`);
    assert.deepEqual(signedTimes(git, sha, NOTES, new Set(["checker"]), 7), { checker: at(777) * 1000 }, `fanned out ${levels} level(s)`);
  }
});

test("signedTimes: a ref that can't date the note takes the fallback (the READY commit's time), never the present; no fallback, no time", () => {
  const { git, sha } = scratch();
  const t = signedTimes((args) => { if (args[0] === "log") throw new Error("shallow"); return git(args); }, sha, NOTES, new Set(["checker"]), 4242);
  assert.deepEqual(t, { checker: 4242 });
  assert.deepEqual(signedTimes(() => { throw new Error("no"); }, sha, NOTES, new Set(["checker"]), null), {}, "nothing to say: no key");
  assert.deepEqual(signedTimes(git, "not-a-sha", NOTES, new Set(["checker"]), 1), {}, "a sha that isn't one is never passed to git");
});

test("factsFor carries signedAt beside signed, and derivePhase puts reviews on the derived card", () => {
  const { git, sha } = scratch();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", sha], at(100));
  git(["update-ref", "refs/remotes/origin/main", "main"]);
  const head = { branch: "work-x", sha, at: at(10) * 1000, message: "work\n\nBoard-Id: work-x" };
  const cfg = { ...config, collector: { ...config.collector, remote: "origin", mainBranch: "main" } };
  const facts = factsFor(git, head, { config: cfg, line: [], deployed: null });
  assert.deepEqual(facts.signedAt, { checker: at(100) * 1000 });
  const card = { id: "work-x", level: "Full", phase: "checker" };
  const d = derivePhase(card, facts, cfg);
  assert.equal(d.phase, "security", "the next unsigned review");
  assert.deepEqual(d.reviews, { checker: at(100) * 1000 });
  git(["notes", "--ref=refs/notes/security", "add", "-m", "SECURE", sha], at(300));
  const d2 = derivePhase(card, factsFor(git, head, { config: cfg, line: [], deployed: null }), cfg);
  assert.equal(d2.phase, "ship");
  assert.deepEqual(d2.reviews, { checker: at(100) * 1000, security: at(300) * 1000 });
});

test("derivePhase: no head, no notes, or no times give no reviews field; a sign-off with no time is left out, not guessed", () => {
  assert.equal(Object.hasOwn(derivePhase({ id: "a" }, { head: null }, config), "reviews"), false);
  const head = { branch: "b", sha: "a".repeat(40), at: 5, message: "Board-Id: a" };
  assert.equal(Object.hasOwn(derivePhase({ id: "a" }, { head, signed: new Set(), signedAt: {}, onMain: false }, config), "reviews"), false);
  assert.equal(Object.hasOwn(derivePhase({ id: "a" }, { head, signed: new Set(["checker"]), onMain: false }, config), "reviews"), false, "facts from an older caller");
  const d = derivePhase({ id: "a", level: "Full" }, { head, signed: new Set(["checker", "security"]), signedAt: { checker: 9, security: "x" }, onMain: false }, config);
  assert.deepEqual(d.reviews, { checker: 9 });
  // Only a phase the head is signed on: a time for an unsigned phase (a stale map) is not a review.
  const odd = derivePhase({ id: "a", level: "Full" }, { head, signed: new Set(["security"]), signedAt: { checker: 9, security: 8 }, onMain: false }, config);
  assert.deepEqual(odd.reviews, { security: 8 });
  // No head: nothing to be signed on, whatever the map says.
  assert.equal(Object.hasOwn(derivePhase({ id: "a" }, { head: null, signed: new Set(["checker"]), signedAt: { checker: 9 } }, config), "reviews"), false);
});

test("underLive: a live tip that moved past the run's drops the older commit's reviews with its READY", () => {
  const phases = config.phases;
  const d = { phase: "ship", head: "a".repeat(40), readyAt: 1, waitingFor: [], reviews: { checker: 5 } };
  assert.equal(underLive(d, { phase: "ship", headSha12: "b".repeat(12) }, phases).reviews, undefined);
  assert.deepEqual(underLive(d, { phase: "ship", headSha12: "a".repeat(12) }, phases).reviews, { checker: 5 }, "the same head keeps them");
});

// ---- the page ----
const NOW = Date.now(), MIN = 60e3;
const has = (r, k) => !!r && typeof r === "object" && !Array.isArray(r) && Number.isFinite(r[k]);
function page(steps, reviews, card = {}) {
  const b = loadNames(["derivedOf", "enrich", "initRow", "renderAll"]);
  Object.assign(b.state, {
    initRaw: [], steps, waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [],
    // The repository's own phase moves on with the notes (collector/derive.mjs): the first review without one, else ship.
    derived: [{ id: "all", at: NOW, cards: { "rev-card": { phase: card.level === "Quick" ? (has(reviews, "checker") ? "ship" : "checker") : has(reviews, "security") ? "ship" : has(reviews, "checker") ? "security" : "checker", head: "a".repeat(40), at: NOW, ...(reviews ? { reviews } : {}) } } }],
    initiatives: [{ id: "rev-card", num: 7, name: "A card", status: "active", phase: "build", size: "S", who: "Boardsmith", level: "Full", customerText: false, lookChange: false, ...card }],
  });
  return b;
}
const s = (phase, kind, at, extra = {}) => ({ id: `${phase}-${kind}-${at}`, init: "rev-card", phase, kind, who: "Someone", at, ...extra });

test("the page: a card whose reviewers signed but logged nothing moves past review and lights both reviews done", () => {
  const steps = [s("build", "start", NOW - 90 * MIN), s("build", "end", NOW - 60 * MIN)];
  const stuck = page(steps, undefined);
  const before = stuck.enrich(stuck.state.initiatives[0]);
  assert.equal(before.phase, "checker", "no end step and no note: the card waits at review");
  const b = page(steps, { checker: NOW - 50 * MIN, security: NOW - 40 * MIN });
  const out = b.enrich(b.state.initiatives[0]);
  assert.equal(out.phase, "ship", "both reviews signed: the next phase is ship");
  const reviewed = out.phaseLog.filter((e) => e.derived || e.phase === "checker" || e.phase === "security");
  assert.equal(JSON.stringify(reviewed.map((e) => [e.phase, e.end]).sort()), JSON.stringify([["checker", NOW - 50 * MIN], ["security", NOW - 40 * MIN]]));
  const html = b.initRow(out);
  assert.match(html, /class="step done" title="Checker">Checker<small class="seen"[^>]*>signed \d/);
  assert.match(html, /class="step done" title="Security">Security<small class="seen"[^>]*>signed \d/);
  assert.doesNotMatch(html, /title="(Checker|Security)">[A-Za-z]+<small class="norec">/, "not 'no record': the note is the record");
  assert.ok(out.phaseLog.filter((e) => e.signed).length === 2, "the two derived ends are marked signed");
});

test("the page: one signed, one not: the card waits at the unsigned review; skipped reviews stay skipped", () => {
  const steps = [s("build", "start", NOW - 90 * MIN), s("build", "end", NOW - 60 * MIN)];
  const b = page(steps, { checker: NOW - 50 * MIN });
  assert.equal(b.enrich(b.state.initiatives[0]).phase, "security");
  const q = page(steps, { checker: NOW - 50 * MIN }, { level: "Quick" });
  assert.equal(q.enrich(q.state.initiatives[0]).phase, "ship", "Quick needs no Security: Checker's note is all it needs");
});

test("the page: a hand-logged end within five minutes of the note is the same sign-off (one entry); an older end is an earlier head's, so the note adds its own", () => {
  const note = NOW - 30 * MIN;
  const same = page([s("build", "end", NOW - 60 * MIN), s("checker", "start", NOW - 40 * MIN), s("checker", "end", note + 2 * MIN)], { checker: note });
  const a = same.enrich(same.state.initiatives[0]);
  assert.equal(a.phaseLog.filter((e) => e.phase === "checker").length, 1, "no second entry");
  const older = page([s("build", "end", NOW - 120 * MIN), s("checker", "start", NOW - 110 * MIN), s("checker", "end", NOW - 100 * MIN), s("build", "start", NOW - 90 * MIN)], { checker: note });
  const o = older.enrich(older.state.initiatives[0]);
  assert.ok(o.phaseLog.some((e) => e.phase === "checker" && e.end === note && e.derived !== false), "the note's own end for the later head");
});

test("the page: a bad reviews field changes nothing (a phase the board doesn't have, a time that isn't one, a list)", () => {
  const steps = [s("build", "start", NOW - 90 * MIN), s("build", "end", NOW - 60 * MIN)];
  for (const bad of [{ nonsense: NOW }, { checker: "x" }, { checker: null }, [NOW], "checker"]) {
    const b = page(steps, bad);
    const out = b.enrich(b.state.initiatives[0]);
    assert.equal(out.phase, "checker", JSON.stringify(bad));
    assert.equal(out.phaseLog.some((e) => e.signed || e.phase === "nonsense"), false, `no entry made from ${JSON.stringify(bad)}`);
  }
});

test("the page: a hand-logged WAIT end (the agent was busy) is no sign-off, so it does not hide the note", () => {
  const note = NOW - 30 * MIN;
  const b = page([s("build", "end", NOW - 60 * MIN), s("checker", "end", note, { wait: "busy" })], { checker: note, security: note });
  assert.equal(b.enrich(b.state.initiatives[0]).phaseLog.filter((e) => e.signed && e.phase === "checker").length, 1);
});

test("the page: a live tip that moved past the repository copy drops that copy's reviews (the same rule as the collector's)", () => {
  const HEAD = "a1b2c3d4e5f6" + "0".repeat(28);
  const reading = (head12) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 1e3, probe: null, pageVersion: null }, cards: { "rev-card": { num: 7, phase: "ship", headSha12: head12, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: NOW - 1e3 } }, agents: {} });
  for (const [head12, kept] of [[HEAD.slice(0, 12), true], ["f".repeat(12), false]]) {
    const b = loadNames(["derivedOf", "liveCard", "probeEvent"]);
    Object.assign(b.state, { initRaw: [], steps: [], waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], initiatives: [{ id: "rev-card", num: 7, name: "A card", status: "active", phase: "build", size: "S", who: "Boardsmith" }],
      derived: [{ id: "all", at: NOW, cards: { "rev-card": { phase: "ship", head: HEAD, readyAt: NOW - 30 * MIN, reviews: { checker: NOW - 20 * MIN }, at: NOW } } }] });
    b.probeEvent({ type: "data", result: { payload: reading(head12) } }, {});
    assert.equal(!!b.derivedOf("rev-card").reviews, kept, `live head ${head12.slice(0, 4)}`);
  }
});

// ---- done-when 2: a pushed branch named for the card, with no commits yet, shows the card as being worked ----
// A repository whose main has one commit (signed by Checker, as any main commit may be) and a remote branch at that same commit.
function bareRepo(branch) {
  const { git } = scratch();
  const main = git(["rev-parse", "main"]).trim();
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", main], at(50));
  git(["update-ref", "refs/remotes/origin/main", main]);
  git(["update-ref", `refs/remotes/origin/${branch}`, main]);
  return { git, main };
}
const CARD = { id: "bare-card", num: 71, name: "A card", status: "active", level: "Quick", customerText: false };

test("done-when 2: a branch named for the card with no commits beyond main is build, not ship or live (derive)", () => {
  const { git } = bareRepo("build/bare-card");
  const heads = remoteHeads(git, "origin").filter((h) => h.branch === "build/bare-card");
  assert.equal(heads.length, 1);
  const cfg = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", collector: { repoPath: "/x", notes: NOTES } });
  const d = derivePhase(CARD, factsFor(git, heads[0], { config: cfg, line: [], deployed: null }), cfg);
  assert.equal(d.phase, cfg.collector.buildPhase);
  assert.equal(d.firm, false);
  assert.equal(d.reviews, undefined, "main's sign-off note is not the card's");
  assert.ok(d.head, "a head: the page sees work, the 30-minute abandon rule does not apply");
  assert.equal(d.onMain, undefined);
});

test("done-when 2: the same tip is still on main when it carries the card's trailer or its #C subject (a shipped, left branch)", () => {
  for (const msg of ["work\n\nBoard-Id: bare-card", "#C71: work"]) {
    const cfg = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", collector: { repoPath: "/x", notes: NOTES } });
    const facts = { head: { branch: "build/bare-card", sha: "a".repeat(40), at: 1, message: msg }, signed: new Set(["checker"]), onMain: true, deployed: false };
    assert.equal(derivePhase(CARD, facts, cfg).phase, cfg.collector.shipPhase, msg);
  }
  const cfg = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", collector: { repoPath: "/x", notes: NOTES } });
  const other = { head: { branch: "build/another-card", sha: "a".repeat(40), at: 1, message: "base" }, signed: new Set(), onMain: true, deployed: false };
  assert.equal(derivePhase(CARD, other, cfg).phase, cfg.collector.shipPhase, "a branch with another name is not this card's bare branch");
});

test("done-when 2: the probe reads the same bare branch as build, with no main sign-offs and not on main", () => {
  const { git, main } = bareRepo("build/bare-card");
  const cfg = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", collector: { repoPath: "/x", notes: NOTES } });
  const repo = { git, remote: "origin", main: "main", notes: NOTES, tips: remoteTips(git, "origin"), live: null, ids: new Set(), repo: null };
  const st = cardState(CARD, repo, cfg, Date.now());
  assert.equal(st.phase, cfg.collector.buildPhase);
  assert.equal(st.headSha12, main.slice(0, 12));
  assert.equal(st.onMain, false);
  assert.deepEqual(st.signed, []);
  assert.ok(st.seen.includes("build") && !st.seen.includes("ship"), JSON.stringify(st.seen));
  // The branch with the card's trailer on main stays what it was.
  const { git: g2 } = bareRepo("build/bare-card");
  g2(["update-ref", "-d", "refs/remotes/origin/build/bare-card"]);
  const r2 = { ...repo, git: g2, tips: remoteTips(g2, "origin") };
  assert.equal(cardState(CARD, r2, cfg, Date.now()).headSha12, null, "no branch, no head");
});
