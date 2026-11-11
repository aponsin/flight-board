// #C914 v2 (stack mode): a card waits for reviewers only when it has a DECLARED stack partner (a later card of the same builder and repository that
// depends on it and has nothing pushed), until the builder's stack-ready signal (a git note written by scripts/stack-ready.mjs) covers it. The probe
// marks the card (stackHold), the dispatch decides, the command decides from the probe's queue file. Dispatch, probe, schema, page, queue file, command.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { dispatchRun, stackQueueFile } from "../collector/store-dispatch.mjs";
import { dispatchJob } from "../collector/probe-board.mjs";
import { cardStates, remoteTips, stackReadyCommits } from "../collector/state.mjs";
import { STACK_HOLD_FROM } from "../collector/stack.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { compatView, initiativeDoc } from "../worker/compat-view.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { stackReady, findConfigPath } from "../scripts/stack-ready.mjs";

// ---- dispatch ----
const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const dep = (...ids) => ({ depends_on: JSON.stringify(ids) });
const world = ({ cards, ev = {}, on = true }) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: on, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const run = (v, dir = mkdtempSync(join(tmpdir(), "srh-")), now = NOW) => dispatchRun(v, { dir, roster: ROSTER, lead: LEAD, now }).items;
const who = (v) => run(v).map((i) => `${i.card}:${i.role}:${i.step}`);
const pushedCard = (n, extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: `${n}`.repeat(12), signed: [], onMain: false, ...extra });
const held = (n, extra = {}) => pushedCard(n, { stackHold: true, ...extra });

test("(a) a pushed card with a declared partner (a later card of the same builder that depends on it, nothing pushed) is held: no review, and the partner starts", () => {
  const v = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": held(1) } });
  assert.deepEqual(who(v), ["c2-next:Boardsmith:build"]);
  const full = world({ cards: [card("c1-base", { review_level: "Full" }), card("c2-next", dep("c1-base"))], ev: { "c1-base": held(1) } });
  assert.deepEqual(who(full), ["c2-next:Boardsmith:build"], "Security is not woken for a held Full card either");
});

test("(b) no partner: a stackHold card dispatches at once (a lone card needs no note), Security too at Full", () => {
  assert.deepEqual(who(world({ cards: [card("c1-base")], ev: { "c1-base": held(1) } })), ["c1-base:Checker:review"]);
  const full = world({ cards: [card("c1-base", { review_level: "Full" })], ev: { "c1-base": held(1) } });
  assert.deepEqual(who(full).sort(), ["c1-base:Checker:review", "c1-base:Security:review"]);
});

test("(b2) grandfathered: the probe sets no stackHold for a card pushed before the cutoff, so a partner makes no difference", () => {
  const v = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": pushedCard(1) } });
  assert.deepEqual(who(v).sort(), ["c1-base:Checker:review", "c2-next:Boardsmith:build"]);
});

test("(c) the switch off is today's dispatch: a stackHold in the evidence is ignored, and a dependency waits for live", () => {
  const v = world({ on: false, cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": held(1) } });
  assert.deepEqual(who(v), ["c1-base:Checker:review"]);
});

test("(c2) a product-repository card is never held, whatever its evidence says", () => {
  const v = world({ cards: [card("c1-base", { repo: "site-one" }), card("c2-next", { repo: "site-one", ...dep("c1-base") })], ev: { "c1-base": held(1) } });
  assert.deepEqual(who(v), ["c1-base:Checker:review"]);
});

test("(c3) the hold lifts by itself once the partner is pushed; a paused, dropped or other builder's dependant is no partner", () => {
  const pushedBoth = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": held(1), "c2-next": pushedCard(2) } });
  assert.ok(who(pushedBoth).includes("c1-base:Checker:review"));
  for (const extra of [{ paused: 1 }, { dropped: 1 }, { blocked_reason: "x" }, { owner_role: "Release" }, { depends_on: "[]" }]) {
    const v = world({ cards: [card("c1-base"), card("c2-next", { ...dep("c1-base"), ...extra })], ev: { "c1-base": held(1) } });
    assert.ok(who(v).includes("c1-base:Checker:review"), `no partner for ${JSON.stringify(extra)}`);
  }
  const v = world({ cards: [card("c1-base"), card("c2-next", { ...dep("c1-base"), repo: "site-one" })], ev: { "c1-base": held(1) } });
  assert.ok(who(v).includes("c1-base:Checker:review"), "another repository's card is no partner");
  const live = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": held(1), "c2-next": { phase: "live", lit: ["live"] } } });
  assert.ok(who(live).includes("c1-base:Checker:review"), "a live dependant is no partner");
});

test("(c4) a held card with a partner still holds back nothing else: another card's review goes", () => {
  const v = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base")), card("c9-other", { owner_role: "Release" })], ev: { "c1-base": held(1), "c9-other": pushedCard(9) } });
  assert.deepEqual(who(v).sort(), ["c2-next:Boardsmith:build", "c9-other:Checker:review"]);
});

// R4: a pushed dependency satisfies a dependency in stack mode
test("(r4a) same builder, board repository: the card starts when its dependency is pushed (not live)", () => {
  const v = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": pushedCard(1) } });
  assert.ok(who(v).includes("c2-next:Boardsmith:build"));
  const gh = world({ cards: [card("c1-base", { repo: "flight-board" }), card("c2-next", { repo: "flight-board", ...dep("c1-base") })], ev: { "c1-base": pushedCard(1, { headSha: `1`.repeat(40), headSha12: undefined }) } });
  assert.ok(who(gh).includes("c2-next:Boardsmith:build"), "the repo word flight-board is the board's; a full sha counts as pushed");
});

test("(r4b) a different builder's dependency still waits until it is live", () => {
  const v = world({ cards: [card("c1-base"), card("c2-next", { owner_role: "Release", ...dep("c1-base") })], ev: { "c1-base": pushedCard(1) } });
  assert.ok(!who(v).includes("c2-next:Release:build"));
  const live = world({ cards: [card("c1-base"), card("c2-next", { owner_role: "Release", ...dep("c1-base") })], ev: { "c1-base": { phase: "live", lit: ["live"] } } });
  assert.ok(who(live).includes("c2-next:Release:build"), "live still satisfies it, as today");
});

test("(r4c) a product-repository card waits for its dependency to be live, pushed or not", () => {
  const v = world({ cards: [card("c1-base", { repo: "site-one" }), card("c2-next", { repo: "site-one", ...dep("c1-base") })], ev: { "c1-base": pushedCard(1) } });
  assert.ok(!who(v).includes("c2-next:Boardsmith:build"));
  const cross = world({ cards: [card("c1-base"), card("c2-next", { repo: "site-one", ...dep("c1-base") })], ev: { "c1-base": pushedCard(1) } });
  assert.ok(!who(cross).includes("c2-next:Boardsmith:build"), "across repositories it still waits");
});

test("(r4d) a dependency with nothing pushed still waits; so does one outside the stack, and so does everything with the switch off", () => {
  const nothing = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": { phase: "build", lit: [] } } });
  assert.deepEqual(who(nothing), ["c1-base:Boardsmith:build"]);
  const outside = world({ cards: [card("c1-base", { owner_role: "Release" }), card("c2-next", dep("c1-base"))], ev: {} });
  assert.ok(!who(outside).includes("c2-next:Boardsmith:build"));
  const out = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": pushedCard(1, { stack: { outside: true } }) } });
  assert.ok(!who(out).includes("c2-next:Boardsmith:build"), "an outsider's head is not a stack's");
  const off = world({ on: false, cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": pushedCard(1) } });
  assert.ok(!who(off).includes("c2-next:Boardsmith:build"));
});

// ---- the queue file (R6) ----
test("(q) stackQueueFile: open cards only, ids and plain values, started = a pushed head, capped at 500", () => {
  const v = world({
    cards: [card("c1-base"), card("c2-next", { ...dep("c1-base"), repo: "site-one" }), card("c3-gone", { dropped: 1 }), card("c4-live"), card("c5-bad", { owner_role: "x<script>", repo: "a b", title: "secret title", depends_on: "not json" }), card("c6-self", dep("c6-self", "c1-base", "c1-base", "BAD ID"))],
    ev: { "c1-base": pushedCard(1), "c4-live": { phase: "live", lit: ["live"] } },
  });
  const q = stackQueueFile(v, NOW);
  assert.equal(q.at, NOW);
  assert.deepEqual(q.cards.map((k) => k.id), ["c1-base", "c2-next", "c5-bad", "c6-self"]);
  assert.deepEqual(q.cards[0], { id: "c1-base", owner_role: "Boardsmith", repo: "", dependsOn: [], started: true });
  assert.deepEqual(q.cards[1], { id: "c2-next", owner_role: "Boardsmith", repo: "site-one", dependsOn: ["c1-base"], started: false });
  assert.deepEqual(q.cards[2], { id: "c5-bad", owner_role: "", repo: "", dependsOn: [], started: false });
  assert.deepEqual(q.cards[3].dependsOn, ["c1-base"]);
  assert.ok(!JSON.stringify(q).includes("secret"));
  const many = { cards: Array.from({ length: 600 }, (_, n) => card(`k${n}`)), evidence: {} };
  assert.equal(stackQueueFile(many, NOW).cards.length, 500);
  assert.deepEqual(stackQueueFile(null, NOW), { at: NOW, cards: [] });
});

test("(q2) the probe's dispatch job writes stack-queue.json beside dispatch.json, the same atomic way (0600), and still writes it when the agents reading is stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "srh-q-"));
  const v = world({ cards: [card("c1-base"), card("c2-next", dep("c1-base"))], ev: { "c1-base": pushedCard(1) } });
  await dispatchJob({ base: "https://board.test", headers: {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => v }), dir, roster: ROSTER, lead: LEAD, now: () => NOW });
  const file = JSON.parse(readFileSync(join(dir, "stack-queue.json"), "utf8"));
  assert.deepEqual(file, stackQueueFile(v, NOW));
  assert.ok(existsSync(join(dir, "dispatch.json")));
  const mode = execFileSync("stat", ["-f", "%Lp", join(dir, "stack-queue.json")], { encoding: "utf8" }).trim();
  assert.equal(mode, "600");
  const dir2 = mkdtempSync(join(tmpdir(), "srh-q-"));
  const stale = { ...v, evidence: { ...v.evidence, agents: { readAt: NOW - 20 * MIN, value: v.evidence.agents.value } } };
  await dispatchJob({ base: "https://board.test", headers: {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => stale }), dir: dir2, roster: ROSTER, lead: LEAD, now: () => NOW });
  assert.ok(existsSync(join(dir2, "stack-queue.json")));
  assert.equal(existsSync(join(dir2, "dispatch.json")), false);
});

// ---- schema ----
const stateWith = (extra) => ({ v: 1, id: "t", cards: { k: { num: 1, phase: null, headSha12: null, signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: 1_790_000_000_000, ...extra } } });
const cardErrors = (state) => stateErrors(state).filter((e) => e.startsWith("cards.k"));
const refused = (extra) => cardErrors(stateWith(extra)).some((e) => /stack/.test(e));

test("(e) the schema accepts stackHold: true, refuses false and other types, and refuses the old stack.hold; the old stack shapes still pass", () => {
  assert.deepEqual(cardErrors(stateWith({ stackHold: true })), []);
  assert.deepEqual(cardErrors(stateWith({ stackHold: true, stack: { tip: "abcdef012345", size: 3, branch: "build/cards" } })), []);
  for (const bad of [false, "true", 1, null, {}, []]) assert.ok(refused({ stackHold: bad }), JSON.stringify(bad));
  assert.ok(refused({ stack: { hold: true } }), "the v1 shape is gone");
  assert.ok(refused({ stack: { hold: true, branch: "build/cards" } }));
  assert.ok(!refused({ stack: { tip: "abcdef012345", size: 3 } }));
  assert.ok(!refused({ stack: { outside: true } }));
  assert.ok(refused({ stack: { tip: "abcdef012345", size: 1 } }));
});

// ---- the page never gets it ----
const row = (id, extra = {}) => ({ id, title: id, num: 1, owner_role: "Boardsmith", review_level: "Quick", paused: 0, dropped: 0, ...extra });
const STACK = { tip: "abcdef012345", size: 3, branch: "build/cards" };
const viewWith = (cards, ev) => ({ tag: "t", now: NOW, cards, asks: [], lists: [], evidence: ev, stackSwitch: [{ repo: "board", stack: true, set_by: "default", set_at: 0 }] });
const evOf = (id, value) => ({ [`cards.${id}`]: { readAt: NOW - 1000, value } });

test("(p) a card with stackHold:true draws exactly as without it, and a stack member keeps its tip and size; so does a product card", () => {
  const base = { lit: ["checker"], phase: "checker", headSha12: "111111111111", signed: [], onMain: false, stack: STACK };
  for (const repo of [undefined, "site-one"]) {
    const c = row("c1-a", repo ? { repo } : {});
    const plain = initiativeDoc(c, { value: base }), withHold = initiativeDoc(c, { value: { ...base, stackHold: true } });
    assert.deepEqual(withHold, plain);
    assert.deepEqual(withHold.stack, { tip: "abcdef012345", size: 3, branch: "build/cards" }, `${repo ?? "board"} card keeps tip/size/branch`);
  }
  const lone = initiativeDoc(row("c2-b"), { value: { lit: ["checker"], stackHold: true } });
  assert.equal(lone.stack, undefined);
  assert.equal(Object.hasOwn(lone, "stackHold"), false);
  const v1 = viewWith([row("c1-a"), row("c2-b", { num: 2 })], { ...evOf("c1-a", base), ...evOf("c2-b", { ...base, headSha12: "222222222222" }) });
  const v2 = viewWith(v1.cards, { ...evOf("c1-a", { ...base, stackHold: true }), ...evOf("c2-b", { ...base, headSha12: "222222222222", stackHold: true }) });
  assert.deepEqual(compatView(v2).collections, compatView(v1).collections, "every collection the page reads is the same");
  assert.ok(!JSON.stringify(compatView(v2).collections).includes("stackHold"));
});

// ---- the probe, on real git ----
const T0 = STACK_HOLD_FROM / 1000 + 10_000; // 10 000 s after the cutoff
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
const READY_REF = "refs/notes/flight-board/stack-ready";
function scratch(t0 = T0) {
  const dir = mkdtempSync(join(tmpdir(), "fb-srh-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = t0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, id) => { at = t0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", `Work on ${id}\n\nBoard-Id: ${id}`]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = () => ({ git: (args) => g(args), remote: "origin", main: "main", notes: cfg.collector.notes, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  const signal = (sha) => g(["notes", `--ref=${READY_REF}`, "add", "-f", "-m", "stack-ready\n2026-11-11T00:00:00Z", sha]);
  const states = (ids, stacks = [""]) => cardStates({ cards: ids.map((id) => ({ id })), config: cfg, repos: { "": repo() }, now: (t0 + 100) * 1000, stacks });
  return { g, commit, sync, repo, signal, states, dir, work, bare };
}
const soloBranch = (s, id = "solo", t = 10) => { s.g(["checkout", "-qb", `build/${id}`]); const head = s.commit(t, "a.md", id); s.g(["checkout", "-q", "main"]); s.sync(); return head; };

test("(d) a pushed card no signal covers is marked stackHold (its stack field untouched), and none after a note on its head; the switch off reads nothing", () => {
  const s = scratch();
  const head = soloBranch(s);
  const held1 = s.states(["solo"]).solo;
  assert.equal(held1.stackHold, true);
  assert.equal(held1.stack, undefined, "the stack field is not touched by the hold");
  assert.equal(s.states(["solo"], []).solo.stackHold, undefined, "switch off: today's reading");
  assert.deepEqual(cardErrors({ v: 1, id: "t", cards: { k: held1 } }), [], "the marked reading passes the schema");
  s.signal(head);
  assert.deepEqual(stackReadyCommits(s.repo()), [head]);
  assert.equal(s.states(["solo"]).solo.stackHold, undefined, "covered: nothing");
});

test("(d2) a note on the tip covers every card under it; a note lower down covers only the cards at or under it; members keep tip and size; same input, same answer", () => {
  const s = scratch();
  s.g(["checkout", "-qb", "build/stack"]);
  s.commit(10, "a.md", "card-one"); const two = s.commit(20, "b.md", "card-two"); const three = s.commit(30, "c.md", "card-three");
  s.g(["checkout", "-q", "main"]);
  s.sync();
  const ids = ["card-one", "card-two", "card-three"];
  const before = s.states(ids);
  for (const id of ids) {
    assert.equal(before[id].stackHold, true, `${id} is marked in a stack not yet READY`);
    assert.deepEqual(before[id].stack, { tip: three.slice(0, 12), tipSha: three, size: 3, branch: "build/stack" }, `${id} keeps its stack field`);
  }
  s.signal(two);
  const mid = s.states(ids);
  assert.equal(mid["card-three"].stackHold, true, "above the noted commit: still marked");
  assert.equal(mid["card-one"].stackHold, undefined);
  assert.equal(mid["card-two"].stackHold, undefined);
  s.signal(three);
  const on = s.states(ids);
  for (const id of ids) { assert.equal(on[id].stackHold, undefined, id); assert.deepEqual(on[id].stack, { tip: three.slice(0, 12), tipSha: three, size: 3, branch: "build/stack" }, id); }
  assert.deepEqual(s.states(ids), on);
});

test("(d3) a card already carrying a review note, or findings (no signed note), is not marked", () => {
  const s = scratch();
  const head = soloBranch(s);
  assert.equal(s.states(["solo"]).solo.stackHold, true);
  s.g(["notes", "--ref=refs/notes/checker", "add", "-m", "FINDINGS: fix the thing", head]);
  const f = s.states(["solo"]).solo;
  assert.deepEqual([f.signed, f.findings], [[], ["checker"]]);
  assert.equal(f.stackHold, undefined, "findings: the card is the builder's, not held");
  s.g(["notes", "--ref=refs/notes/checker", "add", "-f", "-m", "PASS", head]);
  const p = s.states(["solo"]).solo;
  assert.deepEqual(p.signed, ["checker"]);
  assert.equal(p.stackHold, undefined);
});

test("(d4) grandfathered by the head's commit time: before STACK_HOLD_FROM nothing is marked, at it and after it the card is", () => {
  assert.ok(Number.isInteger(STACK_HOLD_FROM) && new Date(STACK_HOLD_FROM).toISOString() === "2026-11-11T18:00:00.000Z");
  const cut = STACK_HOLD_FROM / 1000;
  const before = scratch(cut - 1000); soloBranch(before);
  assert.equal(before.states(["solo"]).solo.stackHold, undefined, "head 1000 s before the cutoff");
  const justBefore = scratch(cut - 1); soloBranch(justBefore, "solo", 0);
  assert.equal(justBefore.states(["solo"]).solo.stackHold, undefined, "head 1 s before");
  const at = scratch(cut); soloBranch(at, "solo", 0);
  assert.equal(at.states(["solo"]).solo.stackHold, true, "head at the cutoff");
  const after = scratch(cut + 1000); soloBranch(after);
  assert.equal(after.states(["solo"]).solo.stackHold, true, "head after it");
  // a stack straddling the cutoff: the old card is grandfathered, the new one is marked
  const mix = scratch(cut - 100);
  mix.g(["checkout", "-qb", "build/mix"]);
  mix.commit(10, "a.md", "card-old"); mix.commit(200, "b.md", "card-new");
  mix.g(["checkout", "-q", "main"]); mix.sync();
  const m = mix.states(["card-old", "card-new"]);
  assert.equal(m["card-old"].stackHold, undefined);
  assert.equal(m["card-new"].stackHold, true);
});

// ---- the command, against a temp bare remote ----
function checkout() {
  const s = scratch();
  s.g(["checkout", "-qb", "build/x"]);
  s.commit(10, "a.md", "card-a");
  return s;
}
const runner = (s) => (args) => s.g(args);
const noteRefs = (s) => execFileSync("git", ["for-each-ref", "refs/notes/stack-ready"], { cwd: s.bare, encoding: "utf8" }).trim();
const originBranch = (s) => execFileSync("git", ["rev-parse", "build/x"], { cwd: s.bare, encoding: "utf8" }).trim();
const T_NOW = "2026-11-11T20:00:00.000Z", T_MS = Date.parse(T_NOW);
const queueOf = (cards, ageMs = 60e3) => ({ at: T_MS - ageMs, cards: cards.map((k) => ({ owner_role: "Boardsmith", repo: "", dependsOn: [], started: false, ...k })) });
const ready = (s, queue, now = () => T_NOW) => stackReady({ run: runner(s), queue, now });

test("(f) a TWO-CARD STACK: after card 1 the queue file lists card-b unstarted behind it, so no note; after card 2 (nothing depends on it) the note is written, no flags", () => {
  const s = checkout();
  const first = ready(s, queueOf([{ id: "card-a", started: false }, { id: "card-b", dependsOn: ["card-a"] }]));
  assert.match(first.line, /^STACK-READY OK: pushed build\/x at [0-9a-f]{12}, more queued \(card-b\): no signal$/);
  assert.equal(first.signal, false);
  assert.equal(originBranch(s), s.g(["rev-parse", "HEAD"]).trim(), "the branch is pushed");
  assert.equal(noteRefs(s), "", "no signal yet");
  s.commit(20, "b.md", "card-b");
  const second = ready(s, queueOf([{ id: "card-a", started: true }, { id: "card-b", dependsOn: ["card-a"], started: true }]));
  assert.match(second.line, /^STACK-READY OK: pushed build\/x at [0-9a-f]{12}, signal written$/);
  assert.ok(noteRefs(s).includes("refs/notes/stack-ready"));
  const body = execFileSync("git", ["notes", "--ref=refs/notes/stack-ready", "show", originBranch(s)], { cwd: s.bare, encoding: "utf8" });
  assert.equal(body, `stack-ready\n${T_NOW}\n`);
  // the collector's fetch (+refs/notes/*:refs/notes/flight-board/*) brings it in, and the probe reads that commit; it covers card-a (under it) too
  s.g(["fetch", "-q", "origin", "+refs/notes/*:refs/notes/flight-board/*"]);
  assert.deepEqual(stackReadyCommits(s.repo()), [originBranch(s)]);
  const states = s.states(["card-a", "card-b"]);
  assert.equal(states["card-a"].stackHold, undefined);
  assert.equal(states["card-b"].stackHold, undefined);
});

test("(f1) a card the file does not list, or whose dependant is another builder's, another repository's or already started, is a last card: the note is written", () => {
  const cases = {
    "not listed": queueOf([{ id: "card-z" }]),
    "other builder": queueOf([{ id: "card-a" }, { id: "card-b", owner_role: "Release", dependsOn: ["card-a"] }]),
    "other repo": queueOf([{ id: "card-a" }, { id: "card-b", repo: "site-one", dependsOn: ["card-a"] }]),
    "started": queueOf([{ id: "card-a" }, { id: "card-b", dependsOn: ["card-a"], started: true }]),
    "no dependency": queueOf([{ id: "card-a" }, { id: "card-b" }]),
  };
  for (const [name, q] of Object.entries(cases)) {
    const s = checkout();
    const r = ready(s, q);
    assert.equal(r.signal, true, name);
    assert.match(r.line, /, signal written$/, name);
    assert.ok(noteRefs(s).includes("refs/notes/stack-ready"), name);
  }
});

test("(f5) a missing or stale queue file writes the note and says so; 14 minutes old still counts, 16 does not", () => {
  const line = /^STACK-READY OK: pushed build\/x at [0-9a-f]{12}, signal written \(the queue file was missing or stale: no wait was possible\)$/;
  const more = (age) => queueOf([{ id: "card-a" }, { id: "card-b", dependsOn: ["card-a"] }], age);
  for (const [name, q] of [["missing", null], ["not an object", "x"], ["no cards", { at: T_MS - 1000 }], ["no time", { cards: [] }], ["16 min", more(16 * 60e3)], ["from the future", more(-10 * 60e3)]]) {
    const s = checkout();
    const r = ready(s, q);
    assert.match(r.line, line, name);
    assert.ok(noteRefs(s).includes("refs/notes/stack-ready"), name);
  }
  const s = checkout();
  const r = ready(s, more(14 * 60e3));
  assert.match(r.line, /more queued \(card-b\): no signal$/);
  assert.equal(noteRefs(s), "");
});

test("(f4) a second READY from another checkout keeps the first one's note: the notes ref is taken from the remote before the new note is added", () => {
  const s = checkout();
  ready(s, null);
  const first = originBranch(s);
  const other = join(s.dir, "other");
  execFileSync("git", ["clone", "-q", s.bare, other]);
  const o = (args) => execFileSync("git", args, { cwd: other, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  o(["config", "user.email", "t@example.com"]); o(["config", "user.name", "T"]);
  o(["checkout", "-qb", "build/y", "origin/build/x"]);
  writeFileSync(join(other, "b.md"), "second\n"); o(["add", "-A"]); o(["commit", "-qm", "Work on card-y\n\nBoard-Id: card-y"]);
  const second = o(["rev-parse", "HEAD"]).trim();
  const done = stackReady({ run: (a) => o(a), queue: null, now: () => "2026-11-11T21:00:00.000Z" });
  assert.match(done.line, /signal written/);
  const listed = execFileSync("git", ["notes", "--ref=refs/notes/stack-ready", "list"], { cwd: s.bare, encoding: "utf8" }).trim().split("\n").map((l) => l.split(" ")[1]).sort();
  assert.deepEqual(listed, [first, second].sort(), "both signals are on the remote");
});

test("(f2) it refuses, changing nothing, on a dirty tree, a detached HEAD, a missing Board-Id trailer, and a failed push", () => {
  const s = checkout();
  writeFileSync(join(s.work, "dirty.md"), "x\n");
  assert.throws(() => ready(s, null), /not clean/);
  assert.equal(noteRefs(s), ""); assert.equal(execFileSync("git", ["branch", "--list"], { cwd: s.bare, encoding: "utf8" }).includes("build/x"), false, "nothing pushed");
  s.g(["add", "-A"]); s.g(["commit", "-qm", "No trailer here"]);
  assert.throws(() => ready(s, null), /Board-Id/);
  s.g(["commit", "-q", "--amend", "-m", "Trailer in the first paragraph only\nBoard-Id: card-a\n\nmore text after"]);
  assert.throws(() => ready(s, null), /Board-Id/, "a trailer that is not in the last paragraph does not count");
  s.g(["commit", "-q", "--amend", "-m", "Work on card-a\n\nBoard-Id: card-a"]);
  s.g(["remote", "set-url", "origin", join(s.dir, "nowhere.git")]);
  assert.throws(() => ready(s, null), /push failed/);
  s.g(["remote", "set-url", "origin", s.bare]);
  s.g(["checkout", "-q", "--detach"]);
  assert.throws(() => ready(s, null), /not a branch/);
  assert.equal(noteRefs(s), "");
});

test("(f3) the command line: no flag, one last line, exit 1 on a refusal, exit 2 on any other argument; --config reads the probe's queue file", () => {
  const s = checkout();
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "stack-ready.mjs");
  const home = mkdtempSync(join(tmpdir(), "srh-home-"));
  const env = { ...process.env, HOME: home, BOARD_CONFIG: "" };
  const go = (args, cwd = s.work) => execFileSync("node", [script, ...args], { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
  for (const bad of [["--more"], ["--config"], ["extra"], ["--config", "--more"]]) {
    try { go(bad); assert.fail(`should exit 2: ${bad}`); } catch (e) { assert.equal(e.status, 2, bad.join(" ")); }
  }
  // a board config and a fresh queue file that lists card-b behind card-a
  const cfgPath = join(home, "board.config.json");
  writeFileSync(cfgPath, JSON.stringify({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", roster: ["Manager", "Boardsmith"], gate: { stateDir: join(home, "state") } }));
  const qdir = join(home, "state", "TestBoard01");
  mkdirSync(qdir, { recursive: true });
  writeFileSync(join(qdir, "stack-queue.json"), JSON.stringify(queueOf([{ id: "card-a" }, { id: "card-b", dependsOn: ["card-a"] }], 0), null, 0).replace(/"at":\d+/, `"at":${Date.now()}`));
  assert.match(go(["--config", cfgPath]), /^STACK-READY OK: pushed build\/x at [0-9a-f]{12}, more queued \(card-b\): no signal$/);
  assert.equal(noteRefs(s), "");
  // BOARD_CONFIG in the environment is read the same way (still no note anywhere)
  const envLine = execFileSync("node", [script], { cwd: s.work, encoding: "utf8", env: { ...env, BOARD_CONFIG: cfgPath }, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
  assert.match(envLine, /more queued \(card-b\): no signal$/);
  assert.equal(noteRefs(s), "");
  // the Claude settings are never opened to find the config: a hook command naming a good config there is ignored (the note is written)
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `node /x/gate/gate.mjs --config ${cfgPath}` }] }] } }));
  assert.match(go([]), /signal written \(the queue file was missing or stale: no wait was possible\)$/);
  writeFileSync(join(s.work, "dirty.md"), "x\n");
  try { go([]); assert.fail("should exit 1"); } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stdout), /^STACK-READY FAILED: the working tree is not clean/);
  }
});
test("findConfigPath: --config first, then BOARD_CONFIG, else none; no other source is read", () => {
  assert.equal(findConfigPath({ args: ["--config", "/a.json"], env: { BOARD_CONFIG: "/b.json" } }), "/a.json");
  assert.equal(findConfigPath({ args: [], env: { BOARD_CONFIG: "/b.json" } }), "/b.json");
  assert.equal(findConfigPath({ args: [], env: {} }), null);
  assert.equal(findConfigPath({ settingsText: `{"c":"node g.mjs --config /nowhere.json"}` }), null, "settings text is not a source");
});
