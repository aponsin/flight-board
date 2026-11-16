// Silent stalls (#C433: #C389 and #C400 sat open a day). (2) A lead's question to the owner in a thread reaches Needs
// you only as a waiting item: a new message of kind "question" from anyone but the owner needs an open waiting item for
// its thread, in the same batch or already on the board. (Part (1), a READY that landed with other context lines, is in
// tests/settled-tips.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";

const config = fullConfig({ owner: "Sam" });
const msg = (over = {}) => ({ op: "set", collection: "messages", doc_id: "m-1", data: { thread: "t-389", from: "Manager", kind: "question", text: "Which one do you want?", at: 1, ...over } });
const ask = (over = {}) => ({ op: "set", collection: "waiting", doc_id: "t-389", data: { kind: "action", text: "Which one do you want?", since: 1, ...over } });
const mirror = (waiting = []) => ({ docs: { waiting, threads: [{ id: "t-389", num: 389, title: "x" }], messages: [], initiatives: [], steps: [] } });
const RE = /^a question to Sam reaches Needs you only as a waiting item: set waiting\/t-389 \{kind, text, since\} in the same batch/;

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

// Designer on 13706b03: --warn (#a85f00) on the light page is 4.47:1, under 4.5 for .9rem text; the words take
// --warn-ink as #C417's did, and the border keeps --warn.
test("the amber banner's words use --warn-ink; its border stays --warn", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(page, /\.stuckline \.sl-owner\{color:var\(--warn-ink\)\}/);
  assert.match(page, /\.stuckline\.amber\{border-color:var\(--warn\);color:var\(--warn-ink\)\}/);
});

// --- #C420's follow-up (the Director): the live state's onMain reads a restacked READY as landed, as the Collector does.

test("the live state: a tip whose change landed with other context lines is on main, read as the main commit", async () => {
  const { landedOn, changeId: stateId, cardState } = await import("../collector/state.mjs");
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
    assert.equal(stateId(g, ready, {}), stateId(g, shipped, {}), "the restacked change has the same change id as the READY");
    const config = { phases: [["build"], ["checker"], ["ship"], ["live"]], skips: [], collector: { notes: {}, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
    const repo = { git: g, ci: () => ({ ci: "passed", ciMin: 1 }), remote: "origin", main: "main", notes: {}, tips: [{ branch: "ctx-card", sha: ready, at: 1, message: "the change\n\nBoard-Id: ctx-card" }], live: shipped, versionPattern: null, ids: {} };
    const s = cardState({ id: "ctx-card", num: 1 }, repo, config, 5);
    assert.deepEqual([s.onMain, s.headSha12, s.phase], [true, shipped.slice(0, 12), "live"]);
    put("A\nb\nNEW\nc\nd\ne\nmore\n", "after");
    g(["checkout", "-q", "ctx-card"]); const rework = put("a\nb\nNEW!\nc\nd\ne\n", "a rework\n\nBoard-Id: ctx-card");
    assert.equal(landedOn(g, "main", rework, {}), null, "a commit of its own: not landed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
