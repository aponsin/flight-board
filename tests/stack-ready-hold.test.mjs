// #C914 (stack mode): reviewers are not woken for a card until the builder's stack-ready signal (a git note on the stack tip, written by
// scripts/stack-ready.mjs) covers it, a stack of one included. Dispatch, probe, schema and the command.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { cardStates, remoteTips, stackReadyCommits } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { stackReady } from "../scripts/stack-ready.mjs";

// ---- dispatch ----
const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const TIP = "abcdef012345", TIP_FULL = `${TIP}${"0".repeat(28)}`;
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = ({ cards, ev = {}, on = true }) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: on, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const run = (v, dir = mkdtempSync(join(tmpdir(), "srh-")), now = NOW) => dispatchRun(v, { dir, roster: ROSTER, lead: LEAD, now }).items;
const held = (n) => ({ lit: ["checker"], phase: "checker", headSha12: `${n}`.repeat(12), signed: [], onMain: false, stack: { hold: true, branch: "build/cards" } });
const covered = (n) => ({ lit: ["checker"], phase: "checker", headSha12: `${n}`.repeat(12), signed: [], onMain: false, stack: { tip: TIP, tipSha: TIP_FULL, size: 3, branch: "build/cards" } });

test("(a) a base card pushed alone, with the next card queued, is held: no Checker or Security item, and no builder turn for it", () => {
  const v = world({ cards: [card("c1-base"), card("c2-next")], ev: { "c1-base": held(1) } });
  const out = run(v);
  assert.deepEqual(out.map((i) => `${i.card}:${i.role}:${i.step}`), ["c2-next:Boardsmith:build"]);
  const full = world({ cards: [card("c1-base", { review_level: "Full" })], ev: { "c1-base": held(1) } });
  assert.deepEqual(run(full), [], "a held card with nothing queued after it still wakes nobody (Security too)");
});

test("(b) a covered stack of 3 wakes Checker once per card, all at the tip's full sha, and a second run does not wake again", () => {
  const dir = mkdtempSync(join(tmpdir(), "srh-"));
  const v = world({ cards: [card("c1-base"), card("c2-mid"), card("c3-tip")], ev: { "c1-base": covered(1), "c2-mid": covered(2), "c3-tip": covered(3) } });
  const first = run(v, dir);
  assert.deepEqual(first.map((i) => i.card).sort(), ["c1-base", "c2-mid", "c3-tip"]);
  assert.ok(first.every((i) => i.role === "Checker" && i.step === "review" && i.sha === TIP && i.fullSha === TIP_FULL && i.onBranch === "build/cards"));
  const second = run(v, dir, NOW + MIN);
  assert.deepEqual(second.map((i) => [i.card, i.since]).sort(), first.map((i) => [i.card, i.since]).sort(), "the same wakes, not new ones (since is kept)");
});

test("(b2) a held card does not hold the covered ones, and a covered one is not pulled back by it", () => {
  const v = world({ cards: [card("c1-base"), card("c2-late")], ev: { "c1-base": covered(1), "c2-late": held(2) } });
  assert.deepEqual(run(v).map((i) => `${i.card}:${i.role}`), ["c1-base:Checker"]);
});

test("(c) the hold never applies with the switch off: the review goes at the card's own commit", () => {
  const v = world({ on: false, cards: [card("c1-base")], ev: { "c1-base": held(1) } });
  const out = run(v);
  assert.deepEqual(out.map((i) => `${i.card}:${i.role}:${i.step}`), ["c1-base:Checker:review"]);
  assert.equal(out[0].sha, "111111111111");
});

// ---- schema ----
const stateWith = (stack) => ({ v: 1, id: "t", cards: { k: { num: 1, phase: null, headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: 1, stack } } });
const stackOk = (stack) => !stateErrors(stateWith(stack)).some((e) => /stack/.test(e));

test("(e) the schema accepts { hold: true } (with a branch), refuses hold false, a hold mixed with a tip, and an unknown key; the old shapes still pass", () => {
  assert.ok(stackOk({ hold: true }));
  assert.ok(stackOk({ hold: true, branch: "build/cards" }));
  for (const bad of [{ hold: false }, { hold: "yes" }, { hold: true, outside: true }, { hold: true, tip: "abcdef012345", size: 2 }, { hold: true, extra: 1 }, { hold: true, branch: "--all" }]) assert.ok(!stackOk(bad), JSON.stringify(bad));
  assert.ok(stackOk({ tip: "abcdef012345", size: 3 }));
  assert.ok(stackOk({ outside: true }));
  assert.ok(!stackOk({ tip: "abcdef012345", size: 1 }));
});

// ---- the probe, on real git ----
const T0 = 1_790_000_000;
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
const READY_REF = "refs/notes/flight-board/stack-ready";
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-srh-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, id) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", `Work on ${id}\n\nBoard-Id: ${id}`]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = () => ({ git: (args) => g(args), remote: "origin", main: "main", notes: cfg.collector.notes, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  const signal = (sha) => g(["notes", `--ref=${READY_REF}`, "add", "-f", "-m", "stack-ready\n2026-11-11T00:00:00Z", sha]);
  const states = (ids, stacks = [""]) => cardStates({ cards: ids.map((id) => ({ id })), config: cfg, repos: { "": repo() }, now: (T0 + 100) * 1000, stacks });
  return { g, commit, sync, repo, signal, states, dir, work, bare };
}

test("(d) a lone card with no signal is held, and none after a stack-ready note on its head; the switch off reads nothing", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/solo"]);
  const head = s.commit(10, "a.md", "solo");
  s.g(["checkout", "-q", "main"]);
  s.sync();
  assert.deepEqual(s.states(["solo"]).solo.stack, { hold: true, branch: "build/solo" });
  assert.equal(s.states(["solo"], []).solo.stack, undefined, "switch off: today's reading");
  assert.deepEqual(stateErrors({ v: 1, id: "t", cards: { k: s.states(["solo"]).solo } }).filter((e) => /stack/.test(e)), [], "the held reading passes the schema");
  s.signal(head);
  assert.deepEqual(stackReadyCommits(s.repo()), [head]);
  assert.equal(s.states(["solo"]).solo.stack, undefined, "covered lone card: nothing, as before");
});

test("(d2) a note on the tip covers every card under it; a note lower down covers only the cards at or under it; same input, same answer", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/stack"]);
  s.commit(10, "a.md", "card-one"); const two = s.commit(20, "b.md", "card-two"); const three = s.commit(30, "c.md", "card-three");
  s.g(["checkout", "-q", "main"]);
  s.sync();
  const ids = ["card-one", "card-two", "card-three"];
  const before = s.states(ids);
  for (const id of ids) assert.deepEqual(before[id].stack, { hold: true, branch: "build/stack" }, `${id} is held in a stack not yet READY`);
  s.signal(two);
  const mid = s.states(ids);
  assert.equal(mid["card-three"].stack.hold, true, "above the noted commit: still held");
  assert.equal(mid["card-one"].stack.hold, undefined);
  assert.equal(mid["card-two"].stack.hold, undefined);
  s.signal(three);
  const on = s.states(ids);
  for (const id of ids) assert.deepEqual(on[id].stack, { tip: three.slice(0, 12), tipSha: three, size: 3, branch: "build/stack" }, id);
  assert.deepEqual(s.states(ids), on);
});

test("(d3) a card already carrying a review note is not pulled back into a hold", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/solo"]);
  const head = s.commit(10, "a.md", "solo");
  s.g(["checkout", "-q", "main"]);
  s.sync();
  s.g(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", head]);
  assert.equal(s.states(["solo"]).solo.stack, undefined);
});

// ---- the command, against a temp bare remote ----
function checkout() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/x"]);
  s.commit(10, "a.md", "card-x");
  return s;
}
const runner = (s) => (args) => s.g(args);
const noteRefs = (s) => execFileSync("git", ["for-each-ref", "refs/notes/stack-ready"], { cwd: s.bare, encoding: "utf8" }).trim();
const originBranch = (s) => execFileSync("git", ["rev-parse", "build/x"], { cwd: s.bare, encoding: "utf8" }).trim();

test("(f) --more pushes the branch with no note; the default writes the note and pushes it, and the collector's read finds it", () => {
  const s = checkout();
  const more = stackReady({ run: runner(s), more: true });
  assert.match(more.line, /^STACK-READY OK: pushed build\/x at [0-9a-f]{12}, more queued \(no signal\)$/);
  assert.equal(originBranch(s), s.g(["rev-parse", "HEAD"]).trim());
  assert.equal(noteRefs(s), "", "no signal yet");
  const done = stackReady({ run: runner(s), now: () => "2026-11-11T00:00:00.000Z" });
  assert.match(done.line, /^STACK-READY OK: pushed build\/x at [0-9a-f]{12}, signal written$/);
  assert.ok(noteRefs(s).includes("refs/notes/stack-ready"));
  const body = execFileSync("git", ["notes", "--ref=refs/notes/stack-ready", "show", originBranch(s)], { cwd: s.bare, encoding: "utf8" });
  assert.equal(body, "stack-ready\n2026-11-11T00:00:00.000Z\n");
  // the collector's fetch (+refs/notes/*:refs/notes/flight-board/*) brings it in, and the probe reads that commit
  s.g(["fetch", "-q", "origin", "+refs/notes/*:refs/notes/flight-board/*"]);
  assert.deepEqual(stackReadyCommits(s.repo()), [originBranch(s)]);
});

test("(f4) a second READY from another checkout keeps the first one's note: the notes ref is taken from the remote before the new note is added", () => {
  const s = checkout();
  stackReady({ run: runner(s), now: () => "2026-11-11T00:00:00.000Z" });
  const first = originBranch(s);
  // a second checkout of the same remote, which has never seen the notes ref
  const other = join(s.dir, "other");
  execFileSync("git", ["clone", "-q", s.bare, other]);
  const o = (args) => execFileSync("git", args, { cwd: other, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  o(["config", "user.email", "t@example.com"]); o(["config", "user.name", "T"]);
  o(["checkout", "-qb", "build/y", "origin/build/x"]);
  writeFileSync(join(other, "b.md"), "second\n"); o(["add", "-A"]); o(["commit", "-qm", "Work on card-y\n\nBoard-Id: card-y"]);
  const second = o(["rev-parse", "HEAD"]).trim();
  const done = stackReady({ run: (a) => o(a), now: () => "2026-11-11T01:00:00.000Z" });
  assert.match(done.line, /signal written$/);
  const listed = execFileSync("git", ["notes", "--ref=refs/notes/stack-ready", "list"], { cwd: s.bare, encoding: "utf8" }).trim().split("\n").map((l) => l.split(" ")[1]).sort();
  assert.deepEqual(listed, [first, second].sort(), "both signals are on the remote");
});

test("(f2) it refuses, changing nothing, on a dirty tree, a detached HEAD, a missing Board-Id trailer, and a failed push", () => {
  const s = checkout();
  writeFileSync(join(s.work, "dirty.md"), "x\n");
  assert.throws(() => stackReady({ run: runner(s) }), /not clean/);
  assert.equal(noteRefs(s), ""); assert.equal(execFileSync("git", ["branch", "--list"], { cwd: s.bare, encoding: "utf8" }).includes("build/x"), false, "nothing pushed");
  s.g(["add", "-A"]); s.g(["commit", "-qm", "No trailer here"]);
  assert.throws(() => stackReady({ run: runner(s) }), /Board-Id/);
  s.g(["commit", "-q", "--amend", "-m", "Trailer in the first paragraph only\nBoard-Id: card-x\n\nmore text after"]);
  assert.throws(() => stackReady({ run: runner(s) }), /Board-Id/, "a trailer that is not in the last paragraph does not count");
  s.g(["commit", "-q", "--amend", "-m", "Work on card-x\n\nBoard-Id: card-x"]);
  s.g(["remote", "set-url", "origin", join(s.dir, "nowhere.git")]);
  assert.throws(() => stackReady({ run: runner(s) }), /push failed/);
  s.g(["remote", "set-url", "origin", s.bare]);
  s.g(["checkout", "-q", "--detach"]);
  assert.throws(() => stackReady({ run: runner(s) }), /not a branch/);
  assert.equal(noteRefs(s), "");
});

test("(f3) the command line prints the one last line and exits 1 on a refusal", () => {
  const s = checkout();
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "stack-ready.mjs");
  const ok = execFileSync("node", [script, "--more"], { cwd: s.work, encoding: "utf8" }).trim().split("\n").pop();
  assert.match(ok, /^STACK-READY OK: pushed build\/x at [0-9a-f]{12}, more queued \(no signal\)$/);
  writeFileSync(join(s.work, "dirty.md"), "x\n");
  try { execFileSync("node", [script], { cwd: s.work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); assert.fail("should exit 1"); } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stdout), /^STACK-READY FAILED: the working tree is not clean/);
  }
});
