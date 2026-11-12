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
import { cardStates, remoteTips } from "../collector/state.mjs";
import { pairsIn, packOf, MAX_PAIRS, BOARD_REPO_WORDS } from "../collector/pairs.mjs";
import { BOARD_REPO_WORDS as DISPATCH_WORDS } from "../collector/store-dispatch.mjs";
import { descends } from "../collector/pair-wait.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { loadNames, step } from "./harness.mjs";

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
  assert.deepEqual({ ...packOf(at, s.two, s.gitStatus) }, { packed: true, installed: false }, "pinned at the landing, not run");
  assert.deepEqual({ ...packOf(at, s.one, s.gitStatus) }, { packed: true, installed: false }, "pinned after the landing: it holds it");
  const ran = [{ n: 3, sha: s.three, ran: false }, { n: 2, sha: s.two, ran: true }];
  assert.deepEqual({ ...packOf(ran, s.two, s.gitStatus) }, { packed: true, installed: true }, "an older pair that ran installs it");
  assert.deepEqual({ ...packOf(ran, s.three, s.gitStatus) }, { packed: true, installed: false }, "the newest holds three but has not run");
  assert.deepEqual({ ...packOf(ran, "x", s.gitStatus) }, { packed: false, installed: false }, "no landing sha");
  assert.deepEqual({ ...packOf(null, s.two, s.gitStatus) }, { packed: false, installed: false });
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
const reading = (c) => ({ v: 1, board: { boardId: "TestBoard42xyz", at: NOW - 12e3, probe: null, pageVersion: null },
  cards: { [ID]: { num: 9, phase: "ship", headSha12: "a1b2c3d4e5f6", signed: ["checker", "security"], onMain: true, ci: "passed", ciMin: 4, liveVersion: null, at: NOW - 12e3, ...c } }, agents: {} });
function row(cardFields, probe, steps = [step(ID, "build", "Builder", "start", NOW - 2 * H)]) {
  const b = loadNames(["enrich", "gates", "initRow", "probeEvent", "phaseMedians", "CONFIG"]);
  const c = { id: ID, num: 9, name: "A board card", status: "active", phase: "ship", size: "S", level: "Full", who: "Builder", repo: "flight-board", createdAt: NOW - 5 * H, ...cardFields };
  Object.assign(b.state, { initRaw: [c], steps, waiting: [], todo: [], ideas: [], events: [], meta: [], ctx: [], messages: [], threads: [], plan: [], timings: [], checkRequests: [], derived: [] });
  if (probe) b.probeEvent({ type: "data", result: { payload: probe } }, {});
  b.state.initiatives = [b.gates(b.enrich(c))];
  b.state.phaseMed = b.phaseMedians(b.state.initiatives);
  return b.initRow(b.state.initiatives[0]);
}
const tile = (h, label) => { const m = h.match(new RegExp(`<div class="(step[^"]*)" title="(${label}[^"]*)"`)); return m && { cls: m[1], title: m[2] }; };

test("the page: Pack lights from packed, Install from installed, both from a Live deploy; nothing else lights them", () => {
  const unlit = row({}, reading({}));
  assert.equal(tile(unlit, "Pack").cls, "step unlit"); assert.equal(tile(unlit, "Install").cls, "step unlit");
  const packed = row({}, reading({ packed: true }));
  assert.equal(tile(packed, "Pack").cls, "step done seen"); assert.equal(tile(packed, "Install").cls, "step unlit");
  assert.match(tile(packed, "Pack").title, /built, not signed/, "Manager's A: Pack means built, never read as signed");
  const installed = row({}, reading({ packed: true, installed: true }));
  assert.equal(tile(installed, "Pack").cls, "step done seen"); assert.equal(tile(installed, "Install").cls, "step done seen");
  const live = row({}, reading({ phase: "live", seen: ["build", "checker", "security", "ship", "live"] }));
  assert.equal(tile(live, "Pack").cls, "step done seen"); assert.equal(tile(live, "Install").cls, "step done seen");
  // installed without packed, or either one off main, is no evidence the page trusts.
  const odd = row({}, reading({ installed: true }));
  assert.equal(tile(odd, "Install").cls, "step unlit");
  const offMain = row({}, reading({ onMain: false, packed: true, installed: true }));
  assert.equal(tile(offMain, "Pack").cls, "step unlit"); assert.equal(tile(offMain, "Install").cls, "step unlit");
});

test("the page: words never light Pack or Install (status done, a next note, a step, a card at live)", () => {
  const words = { status: "done", phase: "live", doneAt: NOW - H, nextNote: "pc49 installed, Pack done", waitingOn: "installed" };
  const steps = [step(ID, "build", "Builder", "start", NOW - 3 * H), step(ID, "install", "Release", "end", NOW - H), step(ID, "pack", "Builder", "end", NOW - 2 * H)];
  for (const h of [row(words, null, steps), row({ phase: "live", nextNote: "installed" }, reading({}), steps)]) {
    assert.equal(tile(h, "Pack").cls, "step unlit"); assert.equal(tile(h, "Install").cls, "step unlit");
  }
});

test("the page: a product card never draws Pack or Install, whatever its reading says", () => {
  const h = row({ repo: "shopsite" }, reading({ packed: true, installed: true }));
  assert.equal(tile(h, "Pack"), null); assert.equal(tile(h, "Install"), null);
});

const TEMPLATE = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const rule = (sel) => { const m = TEMPLATE.match(new RegExp(`\\n${sel.replace(/\./g, "\\.")}\\{([^}]*)\\}`)); return m ? m[1] : null; };
test("Designer on #C969 v2 (1): an unlit tile looks different from a skipped one", () => {
  const unlit = rule(".step.unlit"), skip = rule(".step.skip");
  assert.ok(unlit && skip, "both rules exist");
  assert.match(skip, /line-through/); assert.doesNotMatch(unlit, /line-through/, "unlit is not struck through");
  assert.match(skip, /dashed/); assert.doesNotMatch(unlit, /dashed/, "nor dashed: a dotted outline");
  assert.match(unlit, /dotted/); assert.match(unlit, /opacity/);
});

test("Designer on #C969 v2 (3): a Gated or Queued wait box counts in the phone's --per, and takes a tile's width there", () => {
  const per = (h) => Number(h.match(/class="track" style="--per:(\d+)"/)[1]);
  const plain = row({ phase: "checker" }, reading({ onMain: false }));
  const waited = row({ phase: "checker" }, reading({ onMain: false }), [step(ID, "build", "Builder", "start", NOW - 3 * H), step(ID, "build", "Builder", "end", NOW - 2 * H), step(ID, "checker", "Checker", "start", NOW - 2 * H, { wait: "busy" }), step(ID, "checker", "Checker", "start", NOW - H)]);
  assert.match(waited, /class="wait busy/, "the row draws a wait box");
  const n = (h) => (h.match(/<div class="(step|wait)[ "]/g) || []).length;
  assert.equal(n(waited), n(plain) + 1);
  assert.equal(per(plain), Math.ceil(n(plain) / Math.ceil(n(plain) / 4)), "the even split of the tiles alone");
  assert.equal(per(waited), Math.ceil(n(waited) / Math.ceil(n(waited) / 4)), "the even split counts the wait box");
  assert.match(TEMPLATE, /@media \(max-width:760px\)\{[^\n]*\.track>\.wait\{flex:1 1 calc\(100% \/ var\(--per,4\) - 4px\)\}/, "on the phone a wait box is a tile's width");
});
