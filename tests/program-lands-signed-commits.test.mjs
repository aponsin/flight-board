// #C967 (the owner chose A on #T1779, change 3): a program lands a flight-board commit that is signed, dry-run clean and not held; Release takes only
// what it refuses. scripts/board-land.mjs picks the tips and loops around the release tool's dry run and real run; the probe's dispatch job writes
// land-holds.json. Must still refuse: an unsigned or stale tip, a hold, a failed dry run, a withdrawn PASS (STOP, like #C960). Must still allow: a
// fully signed chain landing in one fast-forward.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landPlan, landRun, refusalReasons, signed, HOLDS_FRESH_MS } from "../scripts/board-land.mjs";
import { landHoldsFile, writeLandHolds } from "../collector/store-dispatch.mjs";

const NOW = 1_800_000_000_000;
const ok = { checker: "PASS Full at abc", security: "SECURE at abc" };
const sha = (n) => String(n).padStart(40, "0");
const head = (n, over = {}) => ({ branch: `build/card-${n}`, sha: sha(n), notes: ok, cards: [`card-${n}`], onMain: false, forward: true, ahead: 1, ...over });
const holds = (cards = {}, at = NOW - 60_000) => ({ at, cards });
const free = (...ids) => Object.fromEntries(ids.map((i) => [i, ""]));

test("a signed, free tip that continues main is tried; the biggest line first", () => {
  const p = landPlan({ heads: [head(1), head(2, { ahead: 3 }), head(3, { ahead: 3, branch: "build/aaa-card-3" })], holds: holds(free("card-1", "card-2", "card-3")), now: NOW });
  assert.deepEqual(p.try.map((h) => h.sha), [sha(3), sha(2), sha(1)], "ahead 3 before ahead 1; equal lines by branch name");
  assert.deepEqual(p.waiting, []);
  assert.deepEqual(p.blocked, []);
});

test("must still refuse: a tip with no Checker PASS or no Security SECURE on it, a STOP, FINDINGS or an empty note, is never tried", () => {
  const variants = [{ checker: null, security: ok.security }, { checker: ok.checker, security: null }, { checker: "STOP: withdrawn (#C960 style)", security: ok.security },
    { checker: "FINDINGS Full: F1", security: ok.security }, { checker: ok.checker, security: "FINDINGS: LOW" }, { checker: "", security: "" }, { checker: "PASSED", security: ok.security },
    { checker: "STOP\nPASS", security: ok.security }];
  for (const notes of variants) {
    const p = landPlan({ heads: [head(1, { notes })], holds: holds(free("card-1")), now: NOW });
    assert.deepEqual(p.try, [], JSON.stringify(notes));
    assert.match(p.waiting[0].why, /not signed/);
  }
  assert.equal(signed(ok), true);
  assert.equal(signed({ checker: "PASS\nmore", security: "SECURE: ok" }), true, "only the first line counts");
});

test("must still refuse: a hold on any card the tip carries, and a card or a file the job cannot read", () => {
  for (const word of ["paused", "dropped", "blocked", "waiting_on"]) {
    const p = landPlan({ heads: [head(1, { cards: ["card-1", "card-2"] })], holds: holds({ "card-1": "", "card-2": word }), now: NOW });
    assert.deepEqual(p.try, [], word);
    assert.match(p.waiting[0].why, new RegExp(`held: card-2 \\(${word}\\)`));
  }
  const unknown = landPlan({ heads: [head(1)], holds: holds({}), now: NOW });
  assert.deepEqual(unknown.try, []); assert.match(unknown.waiting[0].why, /does not list card-1/);
  for (const bad of [null, "x", { at: NOW }, holds({ "card-1": "" }, NOW - HOLDS_FRESH_MS - 1), holds({ "card-1": "" }, NOW + 61_000), { at: "now", cards: { "card-1": "" } }]) {
    const p = landPlan({ heads: [head(1)], holds: bad, now: NOW });
    assert.deepEqual(p.try, [], JSON.stringify(bad));
    assert.match(p.waiting[0].why, /holds file/);
  }
  assert.equal(landPlan({ heads: [head(1)], holds: holds(free("card-1"), NOW - HOLDS_FRESH_MS), now: NOW }).try.length, 1, "10 minutes old is still fresh");
  const noCard = landPlan({ heads: [head(1, { cards: [] })], holds: holds(free("card-1")), now: NOW });
  assert.deepEqual(noCard.try, []); assert.match(noCard.waiting[0].why, /Board-Id/);
});

test("must still refuse (Security LOW1): a malformed Board-Id is never dropped quietly; the tip waits and names it, even when its other cards are free", () => {
  for (const bad of ["Bad Id", "UPPER", "", "x".repeat(65), "a\u001b[31mb", "-lead"]) {
    const p = landPlan({ heads: [head(1, { cards: ["card-1", bad] })], holds: holds(free("card-1")), now: NOW });
    assert.deepEqual(p.try, [], JSON.stringify(bad));
    assert.match(p.waiting[0].why, /a Board-Id is not a card id \(/);
    assert.doesNotMatch(p.waiting[0].why, /\u001b/, "plain words only");
  }
});

test("must still refuse: a stale tip (main is not its ancestor) is reported to Release, not tried; a branch already on main is ignored", () => {
  const p = landPlan({ heads: [head(1, { forward: false }), head(2, { onMain: true }), head(3)], holds: holds(free("card-1", "card-2", "card-3")), now: NOW });
  assert.deepEqual(p.try.map((h) => h.sha), [sha(3)]);
  assert.equal(p.blocked.length, 1);
  assert.equal(p.blocked[0].branch, "build/card-1");
  assert.match(p.blocked[0].reasons[0], /doesn't continue origin\/main/);
  assert.deepEqual(p.waiting, []);
});

test("a fully signed chain lands as its tip in one fast-forward; the branches under it drop out and are never released", () => {
  // A is a branch at the first commit of the line, T the tip two commits on: releasing T alone puts both on main.
  let main = "base";
  const facts = () => ({ heads: [head(1, { ahead: main === "base" ? 1 : 0, onMain: main !== "base" }), head(2, { ahead: 2, onMain: main !== "base" })] });
  const calls = [];
  const release = (s, dry) => { calls.push(`${s.slice(-1)}${dry ? " dry" : " real"}`); if (!dry) main = "T"; return { code: 0, text: "" }; };
  const r = landRun({ readFacts: facts, readHolds: () => holds(free("card-1", "card-2")), release, now: NOW });
  assert.deepEqual(calls, ["2 dry", "2 real"], "the tip only, dry run first");
  assert.deepEqual(r.landed.map((l) => l.branch), ["build/card-2"]);
  assert.deepEqual(r.refused, []);
});

test("must still refuse: a failed dry run lands nothing and its reasons go to Release; the next tip is still tried; a refused tip is not tried twice", () => {
  const calls = [];
  const release = (s, dry) => { calls.push(`${s.slice(-1)}${dry ? " dry" : " real"}`);
    return s === sha(2) ? { code: 1, text: "Not released: 000\n- it changes what the owner's install pins (abc): gate/stop.mjs\n- no PASS from Checker on it in refs/notes/checker\nNothing changed." } : { code: 0, text: "" }; };
  const landedSet = new Set();
  const facts = () => ({ heads: [head(1, { ahead: 1, onMain: landedSet.has(1) }), head(2, { ahead: 2 })] });
  const r = landRun({ readFacts: facts, readHolds: () => holds(free("card-1", "card-2")), release: (s, d) => { const x = release(s, d); if (!d && x.code === 0) landedSet.add(1); return x; }, now: NOW });
  assert.deepEqual(calls, ["2 dry", "1 dry", "1 real"], "T refused at the dry run (no real run), then A is tried and lands");
  assert.deepEqual(r.landed.map((l) => l.branch), ["build/card-1"]);
  assert.equal(r.refused.length, 1);
  assert.deepEqual(r.refused[0].reasons, ["it changes what the owner's install pins (abc): gate/stop.mjs", "no PASS from Checker on it in refs/notes/checker"]);
  assert.deepEqual(r.refused[0].cards, ["card-2"]);
});

test("must still refuse: a PASS withdrawn between the dry run and the real run is the release tool's refusal, reported, not a landing", () => {
  const calls = [];
  const release = (s, dry) => { calls.push(dry ? "dry" : "real"); return dry ? { code: 0, text: "" } : { code: 1, text: "Not released: x\n- no PASS from Checker on it in refs/notes/checker" }; };
  const r = landRun({ readFacts: () => ({ heads: [head(1)] }), readHolds: () => holds(free("card-1")), release, now: NOW });
  assert.deepEqual(calls, ["dry", "real"]);
  assert.deepEqual(r.landed, []);
  assert.deepEqual(r.refused[0].reasons, ["no PASS from Checker on it in refs/notes/checker"]);
});

test("a held, unsigned or unlisted tip makes no release call at all; --dry-run never makes the real run", () => {
  const calls = [];
  const release = (s, dry) => { calls.push(dry); return { code: 0, text: "" }; };
  landRun({ readFacts: () => ({ heads: [head(1, { notes: { checker: "STOP", security: ok.security } }), head(2), head(3)] }), readHolds: () => holds({ "card-2": "paused" }), release, now: NOW });
  assert.deepEqual(calls, [], "no calls");
  const r = landRun({ readFacts: () => ({ heads: [head(1)] }), readHolds: () => holds(free("card-1")), release, now: NOW, dry: true });
  assert.deepEqual(calls, [true]);
  assert.deepEqual(r.landed, [{ branch: "build/card-1", sha: sha(1), dry: true }]);
});

test("refusalReasons reads the release tool's refusal lines, or its first line, cut short", () => {
  assert.deepEqual(refusalReasons("Not released: abc\n- one\n- two\nNothing changed."), ["one", "two"]);
  assert.deepEqual(refusalReasons("Not released: no config named by the gate's hook\n"), ["Not released: no config named by the gate's hook"]);
  assert.deepEqual(refusalReasons(""), []);
  assert.equal(refusalReasons(`- ${"x".repeat(900)}`)[0].length, 300);
});

test("land-holds.json: one plain word per card the store knows, '' for none; written atomically beside the other state files", () => {
  const view = { cards: [
    { id: "free-card" }, { id: "p", paused: 1 }, { id: "d", dropped: 1, paused: 1 }, { id: "b", blocked_reason: "waiting for Owner" }, { id: "w", waiting_on: "Owner: a decision" },
    { id: "empty", blocked_reason: "  ", waiting_on: "" }, { id: "Bad Id" }, { id: 7 }, null,
  ] };
  const f = landHoldsFile(view, NOW);
  assert.deepEqual(f, { at: NOW, cards: { "free-card": "", p: "paused", d: "dropped", b: "blocked", w: "waiting_on", empty: "" } });
  assert.doesNotMatch(JSON.stringify(f), /Owner/, "never a reason text");
  assert.deepEqual(landHoldsFile({}, NOW), { at: NOW, cards: {} });
  const dir = mkdtempSync(join(tmpdir(), "land-holds-"));
  try {
    writeLandHolds(view, { dir, now: NOW });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "land-holds.json"), "utf8")), f);
    assert.equal((statSync(join(dir, "land-holds.json")).mode & 0o777), 0o600);
    assert.deepEqual(readdirSync(dir), ["land-holds.json"], "no .part file left");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the probe writes the holds file on every dispatch run, and a failed write never stops the dispatch", () => {
  const src = readFileSync(new URL("../collector/probe-board.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{[^}]*writeLandHolds[^}]*\} from "\.\/store-dispatch\.mjs"/);
  assert.match(src, /try \{ writeLandHolds\(view, \{ dir, now: now\(\) \}\); \} catch \(e\) \{ log\(/);
});
