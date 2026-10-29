// Silent stalls (#C433: #C389 and #C400 sat open a day). (2) A lead's question to the owner in a thread reaches Needs
// you only as a waiting item: a new message of kind "question" from anyone but the owner needs an open waiting item for
// its thread, in the same batch or already on the board. (Part (1), a READY that landed with other context lines, is in
// tests/settled-tips.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { questionAskErrors, checkWrites, stuckBannerErrors } from "../gate/rules.mjs";

const config = fullConfig({ owner: "Sam" });
const msg = (over = {}) => ({ op: "set", collection: "messages", doc_id: "m-1", data: { thread: "t-389", from: "Manager", kind: "question", text: "Which one do you want?", at: 1, ...over } });
const ask = (over = {}) => ({ op: "set", collection: "waiting", doc_id: "t-389", data: { kind: "action", text: "Which one do you want?", since: 1, ...over } });
const mirror = (waiting = []) => ({ docs: { waiting, threads: [{ id: "t-389", num: 389, title: "x" }], messages: [], initiatives: [], steps: [] } });
const RE = /^a question to Sam reaches Needs you only as a waiting item: set waiting\/t-389 \{kind, text, since\} in the same batch/;

test("a lead's question with no waiting item is refused, naming the item to set (#C389's case)", () => {
  const w = msg();
  assert.match(questionAskErrors(w, { config, mirror: mirror(), batch: [w] })[0], RE);
  assert.match(questionAskErrors(w, { config, mirror: null, batch: [w] })[0], RE, "with no export too");
});

test("with its waiting item in the same batch, or one open on the board, it passes", () => {
  const w = msg(), a = ask();
  assert.deepEqual(questionAskErrors(w, { config, mirror: mirror(), batch: [w, a] }), []);
  assert.deepEqual(questionAskErrors(w, { config, mirror: mirror(), batch: [w, { ...a, op: "update", data: { text: "again" } }] }), [], "an update reopening it");
  assert.deepEqual(questionAskErrors(w, { config, mirror: mirror([{ id: "t-389", kind: "action", text: "q", since: 1 }]), batch: [w] }), []);
});

test("a done item, another thread's item, or one being closed doesn't count", () => {
  const w = msg();
  assert.equal(questionAskErrors(w, { config, mirror: mirror([{ id: "t-389", done: true, since: 1 }]), batch: [w] }).length, 1, "done on the board");
  assert.equal(questionAskErrors(w, { config, mirror: mirror(), batch: [w, ask({ done: true })] }).length, 1, "set done in the batch");
  assert.equal(questionAskErrors(w, { config, mirror: mirror(), batch: [w, { ...ask(), doc_id: "t-1" }] }).length, 1, "another thread's");
  assert.equal(questionAskErrors(w, { config, mirror: mirror(), batch: [w, { ...ask(), op: "delete", data: undefined }] }).length, 1, "a delete");
});

test("only a new question from someone other than the owner: the owner's own, other kinds and updates pass", () => {
  for (const w of [msg({ from: "Sam" }), msg({ kind: "answer" }), msg({ kind: undefined }), { ...msg(), op: "update" }]) assert.deepEqual(questionAskErrors(w, { config, mirror: mirror(), batch: [w] }), [], JSON.stringify(w));
});

test("the gate runs it on every write (checkWrites), with or without an export", () => {
  const w = msg();
  const errs = (batch, m) => checkWrites(batch, { config, who: { role: "Manager", manager: true }, now: 5, state: {}, mirror: m }).errors.filter((e) => /reaches Needs you only as a waiting item/.test(e));
  assert.equal(errs([w], mirror()).length, 1);
  assert.equal(errs([w], null).length, 1);
  assert.equal(errs([w, ask()], mirror()).length, 0);
});

// --- The banner contract (#C433, the Director): every red banner ends with "You: <exact action>"; one that only says
// who it waits on ("Nothing for you · owner: <agent>") is amber; the gate refuses a stuck entry with neither.

test("the gate: a stuck entry needs exactly one of you (the owner's action) or owner (the agent); taking one off needs neither", () => {
  const w = (v) => ({ op: "update", collection: "meta", doc_id: "stuck", data: { "waiting:w": v } });
  for (const v of [{ reason: "r", at: 1 }, { reason: "r", at: 1, you: "  " }, { reason: "r", at: 1, owner: "two words" }, { reason: "r", at: 1, you: "Answer it", owner: "Manager" }])
    assert.match(stuckBannerErrors(w(v))[0] ?? "", /^meta\/stuck waiting:w: give exactly one of "you"/, JSON.stringify(v));
  for (const v of [{ reason: "r", at: 1, you: "Answer #T389's question" }, { reason: "r", at: 1, owner: "Checker" }, { __delete__: true }])
    assert.deepEqual(stuckBannerErrors(w(v)), [], JSON.stringify(v));
  assert.deepEqual(stuckBannerErrors({ op: "delete", collection: "meta", doc_id: "stuck" }), []);
  const lead = { role: "Manager", manager: true };
  assert.equal(checkWrites([w({ reason: "r", at: 1 })], { config, who: lead, now: 5, state: {} }).errors.length, 1, "checkWrites runs it");
});

test("the page: a 'You:' line is red; owner-only lines are amber, and an old entry with neither is the lead's, amber", async () => {
  const { loadNames } = await import("./harness.mjs");
  const b = loadNames(["stuckLines", "renderStuck"]);
  const el = b.els.stuck ?? (b.document.getElementById("stuck"));
  let amber = null;
  el.classList.toggle = (c, on) => { if (c === "amber") amber = on; };
  Object.assign(b.state, { waiting: [{ id: "w1", text: "Pick a colour" }], initRaw: [], derived: [], messages: [], threads: [] });
  b.state.meta.push({ id: "stuck", "waiting:w1": { reason: "no steps", at: 2, owner: "Checker" }, "initiatives:x": { reason: "old", at: 1 } });
  b.renderStuck();
  assert.match(el.innerHTML, /<div class="sl-owner">Manager stuck on x: old · Nothing for you · owner: Manager<\/div>/);
  assert.match(el.innerHTML, /<div class="sl-owner">Manager stuck on Pick a colour: no steps · Nothing for you · owner: Checker<\/div>/);
  assert.equal(amber, true, "nothing for the owner: amber");
  b.state.meta[0]["waiting:w1"] = { reason: "no steps", at: 2, you: "Pick one in #T12" };
  b.renderStuck();
  assert.match(el.innerHTML, /<div class="sl-you">Manager stuck on Pick a colour: no steps · You: Pick one in #T12<\/div>/);
  assert.equal(amber, false, "the owner has a move: red");
});

// --- #C420's follow-up (the Director): the live state's onMain reads a restacked READY as landed, as the Collector does.

test("the live state: a tip whose change landed with other context lines is on main, read as the main commit", async () => {
  const { landedOn, changeId: stateId, cardState } = await import("../collector/state.mjs");
  const { changeId: collectorId } = await import("../collector/collect.mjs");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "fb-landed-")), work = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    execFileSync("git", ["init", "-q", "--bare", bare]); execFileSync("git", ["init", "-q", "-b", "main", work]);
    g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
    const put = (text, msg) => { writeFileSync(join(work, "notes.md"), text); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
    put("a\nb\nc\nd\ne\n", "start");
    g(["checkout", "-qb", "ctx-card"]); const ready = put("a\nb\nNEW\nc\nd\ne\n", "the change\n\nBoard-Id: ctx-card");
    g(["checkout", "-q", "main"]); put("A\nb\nc\nd\ne\n", "context"); const shipped = put("A\nb\nNEW\nc\nd\ne\n", "the change, restacked");
    g(["push", "-q", "--all", "origin"]); g(["fetch", "-q", "origin"]);
    assert.match(g(["cherry", "origin/main", ready]), /^\+ /, "git's patch-id differs");
    const ids = {};
    assert.equal(landedOn(g, "origin/main", ready, ids), shipped);
    assert.ok(Object.keys(ids).length >= 3, "the ids are kept for the next run");
    for (const s of [ready, shipped]) assert.equal(stateId(g, s, {}), collectorId(g, s), "the pinned copy and the collector's agree");
    const config = { phases: [["build"], ["checker"], ["ship"], ["live"]], skips: [], collector: { notes: {}, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
    const repo = { git: g, ci: () => ({ ci: "passed", ciMin: 1 }), remote: "origin", main: "main", notes: {}, tips: [{ branch: "ctx-card", sha: ready, at: 1, message: "the change\n\nBoard-Id: ctx-card" }], live: shipped, versionPattern: null, ids: {} };
    const s = cardState({ id: "ctx-card", num: 1 }, repo, config, 5);
    assert.deepEqual([s.onMain, s.headSha12, s.phase], [true, shipped.slice(0, 12), "live"]);
    put("A\nb\nNEW\nc\nd\ne\nmore\n", "after");
    g(["checkout", "-q", "ctx-card"]); const rework = put("a\nb\nNEW!\nc\nd\ne\n", "a rework\n\nBoard-Id: ctx-card");
    assert.equal(landedOn(g, "main", rework, {}), null, "a commit of its own: not landed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
