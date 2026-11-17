// #C890 (half 2 of #C863, the #C731 case): a part of a card is named by a commit sha cited in its next_note (7 to 40 hex characters). The probe does not read the card
// as live while any cited sha is not an ancestor of main, and says which one is missing; a sha it cannot find counts as not on main; a note with no sha reads as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState, citedShas } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";

const T = Date.now() - 1234;
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const card = (nextNote) => ({ id: "a-card", num: 890, level: "Quick", phase: "plan", nextNote });

// A repository whose main holds the card's docs-only commit (so it is landed and reads live); a second commit exists on a branch that never reached main.
// code: the card's commit changes code (src/a.mjs), so it needs an install and reads ship, not live (Checker 2's M1 on #C1104).
function world({ code = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-parts-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "gc.auto", "0"]); git(["config", "maintenance.auto", "false"]); // #C1133: no detached background maintenance racing the fixture's reads
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, code ? "src" : "docs"), { recursive: true }); writeFileSync(join(dir, code ? "src/a.mjs" : "docs/a.md"), "a\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "the card\n\nBoard-Id: a-card"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["update-ref", "refs/remotes/origin/main", sha]); git(["update-ref", "refs/remotes/origin/build/a-card", sha]);
  // an unmerged part: a commit on a side branch
  git(["switch", "-q", "-c", "side", base]); writeFileSync(join(dir, "side.txt"), "s\n"); git(["add", "-A"]); git(["commit", "-q", "-m", "a part not on main"]);
  const side = git(["rev-parse", "HEAD"]).trim();
  const tips = [{ branch: "build/a-card", sha, at: T, message: "the card\n\nBoard-Id: a-card" }, { branch: "main", sha, at: T, message: "" }];
  return { sha, base, side, repo: () => ({ git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, versionPattern: null }) };
}

test("citedShas: only a sha marked by the word part counts; 7 to 40 hex characters with a digit and a letter; not a long number, a date, a plain word, a longer word, or upper case", () => {
  assert.deepEqual(citedShas("part 3fa91c2 and part 0123456789abcdef0123456789abcdef01234567, again part 3fa91c2"), ["3fa91c2", "0123456789abcdef0123456789abcdef01234567"]);
  assert.deepEqual(citedShas("built at part 1794873311092 on part 2026-11-16, part defaced and part decade, #C1115, v3.19.0"), []);
  assert.deepEqual(citedShas("part abc123 is too short; part 3FA91C2 is upper case; part x3fa91c2 and part 3fa91c2z are inside a longer word"), []);
  assert.deepEqual(citedShas("(part 3fa91c2), part\n3fa91c2."), ["3fa91c2"], "punctuation around a marked sha is fine");
  assert.deepEqual(citedShas("superseded tip 3fa91c2, review tip 0123456789abcdef0123456789abcdef01234567, old stack a1b2c3d4"), [], "an unmarked sha is ignored");
  assert.deepEqual(citedShas("parts 3fa91c2, apart 3fa91c2, part: 3fa91c2"), [], "the marker is the word part, then a space, then the sha");
  assert.deepEqual(citedShas(null), []);
  assert.deepEqual(citedShas(""), []);
  const many = Array.from({ length: 14 }, (_, i) => `part a1b2c3${i.toString(16)}`).join(" ");
  assert.equal(citedShas(many).length, 10, "ten at most");
});

test("every cited sha on main reads live; a note with no sha reads as before", () => {
  const w = world();
  const none = cardState(card("built it, nothing else to say"), w.repo(), cfg, T);
  assert.equal(none.phase, "live");
  assert.equal(Object.hasOwn(none, "partsMissing"), false);
  const all = cardState(card(`part ${w.base.slice(0, 7)} and part ${w.sha}`), w.repo(), cfg, T);
  assert.equal(all.phase, "live", "base is an ancestor of main, the card's own commit is main");
  assert.equal(Object.hasOwn(all, "partsMissing"), false);
});

test("an UNMARKED sha not on main holds nothing; a note with no marker behaves as today", () => {
  const w = world();
  const s = cardState(card(`superseded tip ${w.side.slice(0, 9)}, review tip ${w.side}, a1b2c3d4e5 was never pushed`), w.repo(), cfg, T);
  assert.equal(s.phase, "live");
  assert.equal(Object.hasOwn(s, "partsMissing"), false);
  const mixed = cardState(card(`old ${w.side.slice(0, 9)}; part ${w.base.slice(0, 7)}`), w.repo(), cfg, T);
  assert.equal(mixed.phase, "live", "the unmarked missing sha is ignored beside a marked one on main");
});

test("one missing sha holds the card below live and names that sha; a sha the repository cannot find counts as missing", () => {
  const w = world();
  const s = cardState(card(`part ${w.base.slice(0, 7)} and part ${w.side.slice(0, 9)}`), w.repo(), cfg, T);
  assert.equal(s.phase, "ship", "held at ship, not live");
  assert.deepEqual(s.partsMissing, [w.side.slice(0, 9)], "names the missing one only");
  assert.ok(!s.seen.includes("live"), "live is not among the phases seen");
  const wrap = (c) => stateErrors({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {}, cards: { "a-card": c } });
  assert.deepEqual(wrap(s), [], "the reading with partsMissing passes the state schema");
  assert.notDeepEqual(wrap({ ...s, partsMissing: ["not a sha"] }), [], "a word that is no sha is refused");
  assert.notDeepEqual(wrap({ ...s, partsMissing: [] }), [], "an empty list is not written");
  const unknown = cardState(card("part deadbee1234 was never pushed"), w.repo(), cfg, T);
  assert.equal(unknown.phase, "ship");
  assert.deepEqual(unknown.partsMissing, ["deadbee1234"]);
  // a part that lands later: the next reading reads live again
  const landed = world(); // same shape, no missing sha cited
  assert.equal(cardState(card(`part ${landed.base.slice(0, 7)}`), landed.repo(), cfg, T).phase, "live");
});

test("Checker 2's M1 on #C1104: a card whose commit on main is code reads ship, and its marked parts are still read (partsMissing names the missing one, the phase stays)", () => {
  const w = world({ code: true });
  const none = cardState(card("built it"), w.repo(), cfg, T);
  assert.equal(none.phase, "ship", "a code commit is not live without an install");
  assert.equal(Object.hasOwn(none, "partsMissing"), false);
  const open = cardState(card(`part ${w.base.slice(0, 7)} and part ${w.side.slice(0, 9)}`), w.repo(), cfg, T);
  assert.equal(open.phase, "ship", "the phase is what it read: nothing to hold below live");
  assert.deepEqual(open.partsMissing, [w.side.slice(0, 9)], "the missing part is named even though the card is not at live");
  const wrap = (c) => stateErrors({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {}, cards: { "a-card": c } });
  assert.deepEqual(wrap(open), []);
  const landed = cardState(card(`part ${w.base.slice(0, 7)} and part ${w.sha}`), w.repo(), cfg, T);
  assert.equal(Object.hasOwn(landed, "partsMissing"), false, "every marked part on main: nothing missing, the card may close");
  const unmarked = cardState(card(`superseded tip ${w.side.slice(0, 9)}`), w.repo(), cfg, T);
  assert.equal(Object.hasOwn(unmarked, "partsMissing"), false, "an unmarked sha is ignored");
});

test("a card that is not at live is not touched: a branch still in review keeps its phase, and partsMissing is only read for a head on main", () => {
  const w = world();
  const tips = [{ branch: "build/other-card", sha: w.side, at: T, message: "x\n\nBoard-Id: other-card" }]; // a card with no landing: its tip is the side commit, not on main
  const r = { ...w.repo(), tips };
  const s = cardState({ ...card(`part ${w.side.slice(0, 9)}`), id: "other-card" }, r, cfg, T);
  assert.notEqual(s.phase, "live");
  assert.equal(Object.hasOwn(s, "partsMissing"), false);
});

// #C1133: the plan-part read failed open under load (a full-suite run read no partsMissing where one part was missing; alone it passed 6 of 6). git's `is-ancestor` says "no" with exit 1;
// ANY other failure (a timeout, a spawn error, exit 128) is "unknown", and unknown is never read as "present" or as "landed": the part counts as missing, and a head whose place on main
// could not be read is not read as on main.
const failing = (w, when, status) => { const real = w.repo(); return { ...real, git: (args) => { if (args[0] === "merge-base" && when(args)) throw Object.assign(new Error("git failed"), { status, code: status === null ? "ETIMEDOUT" : undefined }); return real.git(args); } }; };

test("#C1133: a failed git call on a cited part (timeout, exit 128) counts the part as missing, never as present; exit 1 is still the plain 'no' and a landed part still reads present", () => {
  const w = world();
  const note = `part ${w.base.slice(0, 7)}`;
  assert.equal(cardState(card(note), w.repo(), cfg, T).phase, "live", "control: the part is on main");
  for (const status of [null, 128, 2]) {
    const s = cardState(card(note), failing(w, (a) => a.includes(w.base.slice(0, 7)), status), cfg, T);
    assert.deepEqual(s.partsMissing, [w.base.slice(0, 7)], `a failure with status ${status} is not an empty list`);
    assert.equal(s.phase, "ship", "held below live, not landed");
    assert.ok(!s.seen.includes("live"));
  }
  const no = cardState(card(note), failing(w, (a) => a.includes(w.base.slice(0, 7)), 1), cfg, T);
  assert.deepEqual(no.partsMissing, [w.base.slice(0, 7)], "exit 1 is the ordinary 'not an ancestor'");
});

test("#C1133: when the git call that places the head on main fails, the card is not read as shipped or live and its marked parts are still held", () => {
  const w = world();
  const note = `part ${w.base.slice(0, 7)} and part ${w.side.slice(0, 9)}`;
  const everything = (a) => a.includes("--is-ancestor");
  const s = cardState(card(note), failing(w, everything, 128), cfg, T);
  assert.notEqual(s.phase, "live");
  assert.notEqual(s.phase, "ship");
  assert.ok(!s.seen.includes("live"));
  assert.deepEqual(s.partsMissing, [w.base.slice(0, 7), w.side.slice(0, 9)], "no part is read as present when git could not answer");
  const clean = cardState(card("built it"), failing(w, everything, 128), cfg, T);
  assert.equal(Object.hasOwn(clean, "partsMissing"), false, "a card citing no part has nothing to hold");
  const wrap = (c) => stateErrors({ v: 1, board: { boardId: "TestBoard01", at: T, probe: null, pageVersion: null }, agents: {}, cards: { "a-card": c } });
  assert.deepEqual(wrap(s), [], "the reading passes the state schema");
});
