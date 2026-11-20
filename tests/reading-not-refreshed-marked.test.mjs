// #C1377 (Director's audit #C1375, finding 3): when git or GitHub could not be read this run, the collector kept an old reading under a new time (the ship reading said "CI running" for
// v1.226.22 an hour after it was live). First step: a card read from a repository that was not read fresh carries stale (only ever true) and the time of that repository's last good read; a
// good read has no mark, so it clears the next run; the page draws it grey: "No fresh reading since 10:40", never red, never as current.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { loadNames } from "./harness.mjs";

const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const FRESH_AT = 1_800_000_000_000;

// A repository with one card branch, read through `repoExtra` (fresh, freshAt).
function read(repoExtra) {
  const dir = mkdtempSync(join(tmpdir(), "fb-stale-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
    const commit = (name, msg) => { writeFileSync(join(dir, name), name + "\n"); git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
    commit("a.txt", "base");
    git("checkout", "-q", "-b", "admin/c-card");
    const card = commit("c.txt", "The card's work\n\nBoard-Id: c-card");
    git("checkout", "-q", "main");
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "main"));
    git("update-ref", "refs/remotes/origin/admin/c-card", card);
    const T = FRESH_AT + 60_000;
    const tips = [{ branch: "admin/c-card", sha: card, at: T, message: "The card's work\n\nBoard-Id: c-card" }];
    return cardState({ id: "c-card", num: 1377, level: "Quick", phase: "build" }, { git: (args) => git(...args), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, ...repoExtra }, cfg, T);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a repository not read fresh marks its cards stale, with the time it was last read fresh", () => {
  const r = read({ fresh: false, freshAt: FRESH_AT });
  assert.equal(r.stale, true);
  assert.equal(r.staleSince, FRESH_AT);
  assert.equal(r.phase, read({ fresh: true, freshAt: FRESH_AT }).phase, "the reading's value is what the clone says, only marked: nothing else about it changes");
});

test("a repository never read fresh marks its cards stale with no time; a good read has no mark at all", () => {
  const never = read({ fresh: false });
  assert.equal(never.stale, true);
  assert.equal("staleSince" in never, false);
  for (const extra of [{ fresh: true, freshAt: FRESH_AT }, {}]) {
    const good = read(extra);
    assert.equal("stale" in good, false, JSON.stringify(extra));
    assert.equal("staleSince" in good, false, JSON.stringify(extra));
  }
});

test("the mark fits the state's schema, and only as true with a real time", () => {
  const r = read({ fresh: false, freshAt: FRESH_AT });
  const state = { v: 1, board: { at: FRESH_AT + 60_000 }, cards: { "c-card": { ...r } }, agents: {} };
  assert.deepEqual(stateErrors(state).filter((p) => /stale/.test(p)), []);
  assert.ok(stateErrors({ ...state, cards: { "c-card": { ...r, stale: false } } }).some((p) => /stale/.test(p)), "stale is only ever true");
  assert.ok(stateErrors({ ...state, cards: { "c-card": { ...r, staleSince: "10:40" } } }).some((p) => /staleSince/.test(p)), "the time is a time");
});

test("the compat view carries the mark to the page's derived card, and only for a stale card", () => {
  const view = (value) => compatView({ cards: [{ id: "c-card", num: 1377, owner_role: "Boardsmith", batch: null }], evidence: { "cards.c-card": { value, readAt: FRESH_AT } } }).collections;
  const find = (cols) => cols.derived?.find((d) => d.id === "all")?.cards?.["c-card"] ?? {};
  const stale = find(view({ phase: "build", headSha12: "a".repeat(12), stale: true, staleSince: FRESH_AT }));
  assert.equal(stale.stale, true);
  assert.equal(stale.staleSince, FRESH_AT);
  const good = find(view({ phase: "build", headSha12: "a".repeat(12) }));
  assert.equal("stale" in good, false);
  assert.equal("staleSince" in good, false);
});

test("the page greys a stale card: 'No fresh reading since HH:MM' in its own grey line, nothing on a good one", () => {
  const b = loadNames(["staleLine", "derivedOf", "liveCard", "hhmm", "esc"]);
  b.state.derived.push({ id: "all", at: FRESH_AT, cards: { old: { phase: "build", stale: true, staleSince: FRESH_AT }, noTime: { phase: "build", stale: true }, good: { phase: "build" } } });
  const old = b.staleLine({ id: "old" });
  assert.match(old, /^<span class="stale-read"[^>]*>No fresh reading since \d{1,2}:\d{2}/);
  assert.match(old, new RegExp(`from ${b.hhmm(FRESH_AT).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "the hover repeats the time of the last good reading");
  assert.match(b.staleLine({ id: "noTime" }), />No fresh reading</);
  assert.equal(b.staleLine({ id: "good" }), "");
  assert.equal(b.staleLine({ id: "unknown" }), "");
});
