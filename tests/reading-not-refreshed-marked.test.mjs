// #C1377 (Director's audit #C1375, finding 3): when git or GitHub could not be read this run, the collector kept an old reading under a new time (the ship reading said "CI running" for
// v1.226.22 an hour after it was live). First step: a card read from a repository that was not read fresh carries stale (only ever true) and the time of that repository's last good read; a
// good read has no mark, so it clears the next run; the page draws it grey: "No fresh reading since 10:40", never red, never as current.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState, repoFreshAt, teamShip } from "../collector/state.mjs";
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

// Manager on #C1377: the card's own example, the ship tile's "CI running", is marked too.
test("a ship candidate read from a repository that was not read fresh carries the mark and the time of its last good read; a fresh read carries none", () => {
  const SHA = "e3016d3" + "0".repeat(33), T = FRESH_AT + 60_000;
  const git = (a) => { if (a[0] === "merge-base") throw new Error("not an ancestor"); return ""; };
  const team = (extra = {}) => ({ git, remote: "origin", main: "main", tips: [{ branch: "build/ship-v1.226.23", sha: SHA, at: T - 90 * 60e3, message: "" }], ci: () => ({ ci: "running", ciMin: null }), live: null, ...extra });
  const c = { candidatePattern: "^build/ship-v\\d+\\.\\d+\\.\\d+$", versionPattern: "" };
  const stale = teamShip(team({ fresh: false, freshAt: FRESH_AT }), c, T);
  assert.equal(stale.ci, "running");
  assert.equal(stale.stale, true);
  assert.equal(stale.staleSince, FRESH_AT);
  assert.equal("staleSince" in teamShip(team({ fresh: false }), c, T), false, "never read fresh: a mark with no time");
  for (const extra of [{ fresh: true, freshAt: T }, {}]) assert.equal("stale" in teamShip(team(extra), c, T), false, JSON.stringify(extra));
  assert.equal(teamShip(team({ fresh: false, tips: [] }), c, T), null, "no candidate, nothing to mark");
  const ship = { version: "1.226.23", ci: "running", at: T, stale: true, staleSince: FRESH_AT };
  const state = { v: 1, board: { at: T }, cards: {}, agents: {}, ship };
  assert.deepEqual(stateErrors(state).filter((p) => /ship|stale/.test(p)), [], "the mark fits the state's ship record");
  assert.ok(stateErrors({ ...state, ship: { ...ship, stale: false } }).some((p) => /stale/.test(p)), "only ever true");
});

test("the restart badge's ship words say 'no fresh reading since HH:MM' for a stale candidate, never a bare 'CI running'", () => {
  const NOW = FRESH_AT + 60_000;
  const b = loadNames(["shipCandidate", "probeEvent", "liveOn", "hhmm"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } } });
  const send = (ship) => b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 5e3, probe: null, pageVersion: null }, cards: {}, agents: {}, ship } } }, {});
  send({ version: "1.226.23", ci: "running", at: NOW - 3600e3 });
  assert.equal(b.shipCandidate(NOW), "Ship v1.226.23 CI running");
  send({ version: "1.226.23", ci: "running", at: NOW - 3600e3, stale: true, staleSince: FRESH_AT });
  assert.match(b.shipCandidate(NOW), /^Ship v1\.226\.23 CI running, no fresh reading since \d{1,2}:\d{2}/);
  send({ version: "1.226.23", ci: "running", at: NOW - 3600e3, stale: true });
  assert.equal(b.shipCandidate(NOW), "Ship v1.226.23 CI running, no fresh reading");
});

// Checker 2's F3 on 69f0c5d3: the card's own tiles and its age chip must not read current beside "No fresh reading".
test("a stale card's flag is grey and its age chip says no fresh reading instead of an age; its row greys the tiles; a good card is unchanged", () => {
  const b = loadNames(["evidence", "evidenceOff", "staleWords", "isStaleCard", "derivedOf", "liveCard", "phaseLabel", "asOf", "asOfText", "hhmm", "esc", "dur"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(FRESH_AT + 30_000); } static now() { return FRESH_AT + 30_000; } } });
  b.state.derived.push({ id: "all", at: FRESH_AT + 20_000, cards: { old: { phase: "checker", at: FRESH_AT + 20_000, stale: true, staleSince: FRESH_AT }, good: { phase: "checker", at: FRESH_AT + 20_000 } } });
  const stale = b.evidence({ id: "old", status: "active", phase: "checker" });
  assert.match(stale, /class="evidence old"/, "the flag is grey");
  assert.match(stale, /<small class="asof stale"[^>]*>no fresh reading since \d{1,2}:\d{2}/, "the age chip says why, not 'as of 10 s ago'");
  assert.doesNotMatch(stale, /as of \d+ (s|min) ago/);
  const good = b.evidence({ id: "good", status: "active", phase: "checker" });
  assert.doesNotMatch(good, /evidence old|no fresh reading/);
  assert.match(good, /as of \d+ (s|min) ago/);
  assert.equal(b.isStaleCard({ id: "old", status: "active" }), true);
  assert.equal(b.isStaleCard({ id: "old", status: "done" }), false, "a done card is not greyed");
  assert.equal(b.isStaleCard({ id: "good", status: "active" }), false);
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /\.i-row\.read-stale \.track[^{]*\{[^}]*opacity/, "the row's tiles are greyed by CSS");
  assert.match(html, /<div class="i-row\$\{isStaleCard\(i\)\?" read-stale":""\}">/, "and the row carries the class");
});

// Checker 2's F2 on 69f0c5d3: the bookkeeping sat in the CLI block; it is an exported function now, run here.
test("repoFreshAt: a repository read fresh is stamped now; one that was not keeps its OLD stamp, never the new time; none when it never had one or the stamp is in the future", () => {
  const NOW = FRESH_AT + 10 * 60_000, OLD = FRESH_AT;
  const repos = { "": { fresh: true }, product: { fresh: false }, never: { fresh: false }, future: { fresh: false }, undef: {} };
  const map = repoFreshAt(repos, { "": OLD, product: OLD, future: NOW + 3600e3, junk: 5 }, NOW);
  assert.equal(repos[""].freshAt, NOW, "read fresh: now");
  assert.equal(repos.undef.freshAt, NOW, "fresh is not false: read fresh");
  assert.equal(repos.product.freshAt, OLD, "not fresh: the old stamp, not the new time");
  assert.equal(repos.never.freshAt, null);
  assert.equal(repos.future.freshAt, null, "a stamp from the future is no stamp");
  assert.deepEqual(map, { "": NOW, product: OLD, undef: NOW });
  assert.deepEqual(repoFreshAt({ a: { fresh: false } }, null, NOW), {}, "no file read: nothing kept");
});

test("a fresh live reading speaks for the card: the derived copy's stale mark does not outlive it, and the live reading's own mark replaces it", () => {
  const NOW = FRESH_AT + 60_000;
  const b = loadNames(["staleLine", "derivedOf", "liveCard", "liveAgent", "probeEvent", "hhmm", "esc"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } } });
  Object.assign(b.state, { derived: [{ id: "all", at: NOW, cards: { one: { phase: "build", stale: true, staleSince: FRESH_AT, head: "a".repeat(12) } } }] });
  const live = (card) => b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 10e3, probe: null, pageVersion: null }, cards: { one: card }, agents: {} } } }, {});
  live({ phase: "build", headSha12: "a".repeat(12), signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: NOW - 10e3 });
  assert.equal(b.staleLine({ id: "one" }), "", "the live reading is fresh: no mark");
  live({ phase: "build", headSha12: "a".repeat(12), signed: [], onMain: false, ci: "none", ciMin: null, liveVersion: null, at: NOW - 10e3, stale: true, staleSince: FRESH_AT + 1000 });
  assert.match(b.staleLine({ id: "one" }), new RegExp(`from ${b.hhmm(FRESH_AT + 1000).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "its own mark, its own time");
});

// Designer's look check on 64f02ba8: the age chip never wraps ("AM" alone on a second line at 390 px), and the words are said once per card (the chip), not again in the meta line.
test("the stale age chip stays on one line and the meta line does not repeat its words", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /\.asof\.stale\{[^}]*white-space:nowrap/, "the stale chip must not wrap");
  const meta = html.split('<div class="i-meta">')[1].split('<div class="i-acts">')[0];
  assert.doesNotMatch(meta, /staleLine\(/, "the card's meta line must not draw the stale words a second time");
});
