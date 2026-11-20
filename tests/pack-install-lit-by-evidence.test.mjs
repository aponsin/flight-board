// #C1020: a board card's Pack and Install tiles light from evidence, never from words. The probe reads the deploy pairs in the owner's pair
// folder (board-store-deploy-pc<n>.mjs pins a main commit; its .done holds that pin once the deploy step ran) and git: packed when a pair's pin
// holds the card's landing, installed when such a pair ran. The page lights Pack and Install from those two readings (or a Live deploy) only.
// Real git; fictional repository and names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardStates, remoteTips, buildState } from "../collector/state.mjs";
import { pairsIn, packOf, MAX_PAIRS, BOARD_REPO_WORDS } from "../collector/pairs.mjs";
import { BOARD_REPO_WORDS as DISPATCH_WORDS } from "../collector/store-dispatch.mjs";
import { descends } from "../collector/pair-wait.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { mirrorCard } from "../collector/store-cards.mjs";
import { loadNames, step, readingDoc, setReadings } from "./harness.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI", repos: [{ name: "flight-board", path: "/y", notes: NOTES }, { name: "shopsite", path: "/z", notes: NOTES }] } });
const dirs = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

// A repository whose main holds three landed cards, one after the other: c-one, c-two, c-three.
function scratch() {
  const dir = tmp("fb-pack-");
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.mjs"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const land = (t, id, num) => { at = T0 + t; appendFileSync(join(work, "worker.mjs"), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", `#C${num}: work\n\nBoard-Id: ${id}`]); const s = g(["rev-parse", "HEAD"]).trim(); for (const ref of Object.values(NOTES)) g(["notes", `--ref=${ref}`, "add", "-m", "PASS", s]); return s; };
  const one = land(10, "c-one", 1), two = land(20, "c-two", 2), three = land(30, "c-three", 3);
  // c-four is still on its branch, not on main.
  g(["checkout", "-qb", "build/c-four"]); const four = land(40, "c-four", 4); g(["checkout", "-q", "main"]);
  g(["push", "-q", "--all", "origin"]); g(["push", "-q", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "origin"]);
  const repo = { git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null };
  const gitStatus = (args) => { try { g(args); return { status: 0 }; } catch { return { status: 1 }; } };
  return { one, two, three, four, repo, gitStatus };
}
const pairFile = (dir, n, sha) => writeFileSync(join(dir, `board-store-deploy-pc${n}.mjs`), `// pair ${n}\nconst SIGNED = "${sha}";\n`);
const done = (dir, n, sha) => writeFileSync(join(dir, `board-store-deploy-pc${n}.done`), `${sha}\n`);
const card = (id, num, repo = "flight-board") => ({ id, num, repo, level: "Quick", phase: "ship", status: "active" });

test("pairsIn: every pinned pair, newest first, ran only when its .done holds its own pin", () => {
  const dir = tmp("pairs-"), A = "a".repeat(40), B = "b".repeat(40);
  assert.deepEqual(pairsIn(dir), []); assert.deepEqual(pairsIn(join(dir, "nope")), []); assert.deepEqual(pairsIn(""), []); assert.deepEqual(pairsIn(undefined), []);
  pairFile(dir, 7, A); done(dir, 7, A);
  pairFile(dir, 9, B); done(dir, 9, A); // a marker holding another pin is no install
  writeFileSync(join(dir, "board-store-deploy-pc10.mjs"), "// no pin\n");
  writeFileSync(join(dir, "board-store-deploy-pc11.done"), `${A}\n`); // a marker with no pair
  writeFileSync(join(dir, "notes-installed.md"), "pc9 installed\n"); // words are not evidence
  assert.deepEqual(pairsIn(dir).map((p) => ({ ...p })), [{ n: 9, sha: B, ran: false }, { n: 7, sha: A, ran: true }]);
  assert.equal(MAX_PAIRS, 200);
  assert.equal(DISPATCH_WORDS, BOARD_REPO_WORDS, "the dispatch and the probe share one set of board repo words");
  assert.equal(typeof descends, "function", "pair-wait still exports descends for the dispatch");
});

test("packOf: a pair whose pin holds the landing packs it; its .done installs it; a pair below the landing shows nothing", () => {
  const s = scratch();
  const below = [{ n: 1, sha: s.one, ran: true }];
  assert.deepEqual({ ...packOf(below, s.two, s.gitStatus) }, { packed: false, installed: false }, "a pair pinned before the landing");
  const at = [{ n: 2, sha: s.two, ran: false }];
  assert.deepEqual({ ...packOf(at, s.two, s.gitStatus) }, { packed: true, installed: false, pack: 2 }, "pinned at the landing, not run");
  assert.deepEqual({ ...packOf(at, s.one, s.gitStatus) }, { packed: true, installed: false, pack: 2 }, "pinned after the landing: it holds it");
  const ran = [{ n: 3, sha: s.three, ran: false }, { n: 2, sha: s.two, ran: true }];
  assert.deepEqual({ ...packOf(ran, s.two, s.gitStatus) }, { packed: true, installed: true, pack: 2 }, "an older pair that ran installs it; the pack named is the oldest that holds the landing");
  assert.deepEqual({ ...packOf(ran, s.three, s.gitStatus) }, { packed: true, installed: false, pack: 3 }, "the newest holds three but has not run");
  assert.deepEqual({ ...packOf(ran, "x", s.gitStatus) }, { packed: false, installed: false }, "no landing sha");
  assert.deepEqual({ ...packOf(null, s.two, s.gitStatus) }, { packed: false, installed: false });
});

// #C1034 (Checker 2's LOW on #C1020): pins are main commits, newest first; the walk stops at the first pin that doesn't hold the landing.
test("packOf stops at the first pin that does not hold the landing: same answers, a capped count of git questions", () => {
  const s = scratch();
  const counted = () => { const c = { n: 0 }; c.git = (args) => { c.n += 1; return s.gitStatus(args); }; return c; };
  // 46 pairs, every one pinned below c-three (the live board's case: a landed card no pair holds yet).
  // #C1309: pins are main commits newest first, so the pairs that hold a landing are a prefix; the older ones are all pinned at c-one, as the real list is.
  const old = Array.from({ length: 46 }, (_, i) => ({ n: 100 - i, sha: s.one, ran: true }));
  const a = counted();
  assert.deepEqual({ ...packOf(old, s.three, a.git) }, { packed: false, installed: false });
  assert.equal(a.n, 1, "one question: the newest pin does not hold it, so no older one does");
  // The newest holds it unrun, then ran pairs going down: it stops at the first one below the landing.
  const mixed = [{ n: 9, sha: s.three, ran: false }, { n: 8, sha: s.two, ran: true }, ...old];
  const b = counted();
  assert.deepEqual({ ...packOf(mixed, s.three, b.git) }, { packed: true, installed: false, pack: 9 });
  assert.ok(b.n <= 2, `at most two questions, got ${b.n}`);
  // Today's answers on the fixtures above are unchanged.
  const c = counted();
  assert.deepEqual({ ...packOf(mixed, s.two, c.git) }, { packed: true, installed: true, pack: 8 }, "pc8 ran and holds c-two");
  assert.ok(c.n <= 3, `a landing two packs old: at most three questions, got ${c.n}`);
  assert.deepEqual({ ...packOf([{ n: 3, sha: s.three, ran: false }, { n: 2, sha: s.two, ran: true }], s.two, s.gitStatus) }, { packed: true, installed: true, pack: 2 });
});

test("cardStates: a landed board card reads packed and installed from the pair folder; product cards and unlanded cards never do", () => {
  const s = scratch(), dir = tmp("pairs-");
  pairFile(dir, 40, s.one); done(dir, 40, s.one);
  pairFile(dir, 41, s.two);
  const repos = { "flight-board": s.repo, shopsite: s.repo };
  const cards = [card("c-one", 1), card("c-two", 2), card("c-three", 3)];
  const out = cardStates({ cards, config: cfg, repos, now: (T0 + 100) * 1000, pairs: pairsIn(dir) });
  assert.equal(out["c-one"].onMain, true);
  assert.equal(out["c-one"].packed, true); assert.equal(out["c-one"].installed, true, "pc40 ran and holds c-one");
  assert.equal(out["c-two"].packed, true); assert.equal(out["c-two"].installed, undefined, "pc41 holds c-two but has not run");
  assert.equal(out["c-three"].packed, undefined, "no pair holds c-three"); assert.equal(out["c-three"].installed, undefined);
  for (const id of Object.keys(out)) assert.deepEqual(stateErrors({ v: 1, board: { boardId: "TestBoard42xyz", at: (T0 + 100) * 1000, probe: null, pageVersion: null }, cards: { [id]: out[id] }, agents: {} }).filter((e) => /packed|installed/.test(e)), [], `${id} fits the schema`);
  const none = cardStates({ cards, config: cfg, repos, now: (T0 + 100) * 1000 });
  for (const id of Object.keys(none)) assert.equal(none[id].packed, undefined, `${id}: no pairs read, nothing lit`);
});

test("cardStates: a product card read from the very checkout the board uses is still never packed (the card's repo word decides)", () => {
  const s = scratch(), dir = tmp("pairs-");
  pairFile(dir, 70, s.three); done(dir, 70, s.three);
  const out = cardStates({ cards: [card("c-two", 2, "shopsite")], config: cfg, repos: { "flight-board": s.repo, shopsite: s.repo }, now: (T0 + 100) * 1000, pairs: pairsIn(dir) });
  assert.equal(out["c-two"].onMain, true);
  assert.equal(out["c-two"].packed, undefined); assert.equal(out["c-two"].installed, undefined);
});

test("cardStates: a card not on main never reads packed, even with a ran pair pinned at its own branch commit", () => {
  const s = scratch(), dir = tmp("pairs-");
  pairFile(dir, 60, s.four); done(dir, 60, s.four);
  const out = cardStates({ cards: [card("c-four", 4)], config: cfg, repos: { "flight-board": s.repo }, now: (T0 + 100) * 1000, pairs: pairsIn(dir) });
  assert.equal(out["c-four"].onMain, false);
  assert.equal(out["c-four"].headSha, s.four, "read at its branch commit, which the pair pins");
  assert.equal(out["c-four"].packed, undefined); assert.equal(out["c-four"].installed, undefined);
});

test("cardStates: a card of another repository never gets packed, even when a pair's pin holds its commit", () => {
  const s = scratch(), dir = tmp("pairs-");
  pairFile(dir, 50, s.three); done(dir, 50, s.three);
  const out = cardStates({ cards: [card("c-one", 1, "shopsite")], config: cfg, repos: { "flight-board": scratch().repo, shopsite: s.repo }, now: (T0 + 100) * 1000, pairs: pairsIn(dir) });
  assert.equal(out["c-one"].onMain, true);
  assert.equal(out["c-one"].packed, undefined); assert.equal(out["c-one"].installed, undefined);
});

test("the schema takes packed and installed as true only", () => {
  const st = (c) => stateErrors({ v: 1, board: { boardId: "TestBoard42xyz", at: Date.now(), probe: null, pageVersion: null }, cards: { x: { num: 1, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: [], onMain: true, ci: "none", ciMin: null, liveVersion: null, at: Date.now(), ...c } }, agents: {} });
  assert.deepEqual(st({ packed: true, installed: true }), []);
  assert.notDeepEqual(st({ packed: false }), []); assert.notDeepEqual(st({ installed: "yes" }), []);
});

// ---- the page ----
const NOW = Date.now(), H = 36e5, ID = "board-c";
// #C1359: the reading's time is made when the reading is, not when the file loads: the page calls a reading stale by the real clock, so a time fixed at load went stale when full suites ran
// side by side (the file waited, the reading aged) and the Pack and Install tiles read unlit. The reading is always 12 s old when the page reads it.
const reading = (c) => { const at = Date.now() - 12e3; return { v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null },
  cards: { [ID]: { num: 9, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: ["checker", "security"], onMain: true, ci: "passed", ciMin: 4, liveVersion: null, at, ...c } }, agents: {} }; };
// #C1382: the row draws the card's reading (state.readings, from the Worker); the probe's own cards are no longer what lights a tile.
function row(cardFields, rd, probe = null, steps = [step(ID, "build", "Builder", "start", NOW - 2 * H)]) {
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "phaseMedians", "CONFIG"]);
  const c = { id: ID, num: 9, name: "A board card", status: "active", phase: "ship", size: "S", level: "Full", who: "Builder", repo: "flight-board", createdAt: NOW - 5 * H, ...cardFields };
  Object.assign(b.state, { initRaw: [c], steps, waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], checkRequests: [], derived: [] });
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } }, {});
  if (rd) setReadings(b, readingDoc(ID, rd));
  b.state.initiatives = [b.gates(b.enrich(c))];
  b.state.phaseMed = b.phaseMedians(b.state.initiatives);
  return b.initRow(b.state.initiatives[0]);
}
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)"`)); return m && { cls: m[1], title: m[2] }; };

test("the page: Pack lights from packed, Install from installed, both from a Live deploy; nothing else lights them", () => {
  // #C1382: the reading's phase decides; a phase not reached is the unlit tile (a board card's Pack and Install are not in the page's own phase list), one passed is done.
  const unlit = row({}, null);
  assert.equal(tile(unlit, "Pack").cls, "step unlit", "no reading"); assert.equal(tile(unlit, "Install").cls, "step unlit");
  const shipping = row({}, { phase: "ship", state: "working", wait: null, working: true });
  assert.equal(tile(shipping, "Pack").cls, "step unlit", "not reached"); assert.equal(tile(shipping, "Install").cls, "step unlit");
  const packing = row({}, { phase: "pack", wait: "pack" });
  assert.equal(tile(packing, "Pack").cls, "step waits proc", "waiting for its pack"); assert.equal(tile(packing, "Install").cls, "step unlit");
  const installing = row({}, { phase: "install", wait: "install", pack: "pc7" });
  assert.equal(tile(installing, "Pack").cls, "step done", "the pack is cut"); assert.equal(tile(installing, "Install").cls, "step waits rel", "waiting for the owner's install");
  const live = row({}, { phase: "live", state: "done", wait: null, with: null });
  assert.equal(tile(live, "Pack").cls, "step done"); assert.equal(tile(live, "Install").cls, "step done");
});

test("the page: words never light Pack or Install (status done, a next note, a step, a card at live)", () => {
  const words = { status: "done", phase: "live", doneAt: NOW - H, nextNote: "pc49 installed, Pack done", waitingOn: "installed" };
  const steps = [step(ID, "build", "Builder", "start", NOW - 3 * H), step(ID, "install", "Release", "end", NOW - H), step(ID, "pack", "Builder", "end", NOW - 2 * H)];
  // With no reading served, even the probe's packed and installed no longer light them: the row draws the reading and nothing else.
  for (const h of [row(words, null, null, steps), row({ phase: "live", nextNote: "installed" }, null, reading({ packed: true, installed: true }), steps)]) {
    assert.equal(tile(h, "Pack").cls, "step unlit"); assert.equal(tile(h, "Install").cls, "step unlit");
  }
});

test("the page: a product card never draws Pack or Install, whatever its reading says", () => {
  const h = row({ repo: "shopsite" }, { phase: "install", wait: "install", pack: "pc7" });
  assert.equal(tile(h, "Pack"), null); assert.equal(tile(h, "Install"), null);
});

const TEMPLATE = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const rule = (sel) => { const m = TEMPLATE.match(new RegExp(`\\n${sel.replace(/\./g, "\\.")}\\{([^}]*)\\}`)); return m ? m[1] : null; };
test("Designer on #C969 v2 (1): an unlit tile looks different from a skipped one", () => {
  const unlit = rule(".step.unlit"), skip = rule(".step.skip");
  assert.ok(unlit && skip, "both rules exist");
  assert.match(skip, /line-through/); assert.doesNotMatch(unlit, /line-through/, "unlit is not struck through");
  assert.match(skip, /dashed/); assert.doesNotMatch(unlit, /dashed/, "nor dashed: a dotted outline");
  assert.match(unlit, /dotted/);
  assert.doesNotMatch(unlit, /opacity/, "no fading: small text keeps 4.5:1 (Designer on ab46d92f: .6 gave 2.46:1)");
});

test("Designer on #C969 v2 (3), after #C1382: the card row draws no Gated or Queued wait box, so the phone's --per is the even split of the tiles alone", () => {
  const per = (h) => Number(h.match(/class="track" style="--per:(\d+)"/)[1]);
  const rd = { phase: "checker", state: "working", wait: null, working: true };
  const plain = row({ phase: "checker" }, rd);
  const waited = row({ phase: "checker" }, rd, null, [step(ID, "build", "Builder", "start", NOW - 3 * H), step(ID, "build", "Builder", "end", NOW - 2 * H), step(ID, "checker", "Checker", "start", NOW - 2 * H, { wait: "busy" }), step(ID, "checker", "Checker", "start", NOW - H)]);
  assert.doesNotMatch(waited, /class="wait /, "a step log's wait is no box in the card row");
  const n = (h) => (h.match(/<div class="(step|wait)[ "]/g) || []).length;
  assert.equal(n(waited), n(plain));
  assert.equal(per(waited), Math.ceil(n(waited) / Math.ceil(n(waited) / 4)), "the even split counts the tiles");
  assert.match(TEMPLATE, /@media \(max-width:760px\)\{[^\n]*\.track>\.wait\{flex:1 1 calc\(100% \/ var\(--per,4\) - 4px\)\}/, "on the phone a wait box is a tile's width");
});

// ---- done board cards: Pack and Install come from the done reading (#C1382), no longer from the probe's closedPacks (#C1388) ----
const DAY = 864e5;

// The store's done_at reaches the probe's card as doneAt (mirrorCard); state.mjs rereadClosed reads it for the closed product cards.
test("a store row closed yesterday becomes a mirror card with doneAt and status done; one with no done_at has neither", () => {
  const now = Date.now();
  const row = { id: "c-one", num: 1, title: "One", repo: "flight-board", created_at: now - 9 * DAY, updated_at: now - DAY, done_at: now - DAY };
  const m = { ...mirrorCard(row), id: row.id };
  assert.equal(m.doneAt, now - DAY, "the store's done_at, as doneAt");
  assert.equal(m.status, "done");
  const open = { ...mirrorCard({ ...row, done_at: null }), id: row.id };
  assert.equal(Object.hasOwn(open, "doneAt"), false, "an open card has no doneAt");
});

test("the state no longer carries closedPacks: the schema refuses the key and buildState takes no packs", () => {
  const base = { v: 1, board: { boardId: "TestBoard42xyz", at: Date.now(), probe: null, pageVersion: null }, cards: {}, agents: {} };
  assert.deepEqual(stateErrors(base), []);
  assert.notDeepEqual(stateErrors({ ...base, closedPacks: { "c-one": { packed: true } } }), [], "an unknown key");
  const built = buildState({ id: "TestBoard42xyz", now: Date.now(), probe: "p", pageVersion: "v", cards: {}, agents: {}, packs: { "c-one": { packed: true } } });
  assert.equal(Object.hasOwn(built, "closedPacks"), false);
});

test("the page (#C1382): a done board card's Pack and Install stand done from its done reading; with no reading, or an open card with none, they are unlit", () => {
  const fin = { status: "done", phase: "live", doneAt: NOW - H };
  const dr = { state: "done", phase: "live", wait: null, with: null };
  const both = row(fin, dr);
  assert.equal(tile(both, "Pack").cls, "step done"); assert.equal(tile(both, "Install").cls, "step done");
  for (const h of [row(fin, null), row({}, null), row({ phase: "live" }, null)]) {
    assert.equal(tile(h, "Pack").cls, "step unlit"); assert.equal(tile(h, "Install").cls, "step unlit");
  }
});
