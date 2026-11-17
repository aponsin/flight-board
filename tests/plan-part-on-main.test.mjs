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
function world() {
  const dir = mkdtempSync(join(tmpdir(), "fb-parts-")), git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  mkdirSync(join(dir, "docs"), { recursive: true }); writeFileSync(join(dir, "docs/a.md"), "a\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "the card\n\nBoard-Id: a-card"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  git(["update-ref", "refs/remotes/origin/main", sha]); git(["update-ref", "refs/remotes/origin/build/a-card", sha]);
  // an unmerged part: a commit on a side branch
  git(["switch", "-q", "-c", "side", base]); writeFileSync(join(dir, "side.txt"), "s\n"); git(["add", "-A"]); git(["commit", "-q", "-m", "a part not on main"]);
  const side = git(["rev-parse", "HEAD"]).trim();
  const tips = [{ branch: "build/a-card", sha, at: T, message: "the card\n\nBoard-Id: a-card" }, { branch: "main", sha, at: T, message: "" }];
  return { sha, base, side, repo: () => ({ git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: null, versionPattern: null }) };
}

test("citedShas: a word of 7 to 40 hex characters with a digit and a letter; not a long number, a date, a plain word, a longer word, or upper case", () => {
  assert.deepEqual(citedShas("parts: 3fa91c2 and 0123456789abcdef0123456789abcdef01234567, again 3fa91c2"), ["3fa91c2", "0123456789abcdef0123456789abcdef01234567"]);
  assert.deepEqual(citedShas("built at 1794873311092 on 2026-11-16, defaced and decade, #C1115, v3.19.0"), []);
  assert.deepEqual(citedShas("abc123 is too short; 3FA91C2 is upper case; x3fa91c2 and 3fa91c2z are inside a longer word"), []);
  assert.deepEqual(citedShas("(3fa91c2), sha:3fa91c2."), ["3fa91c2"], "punctuation around a sha is fine");
  assert.deepEqual(citedShas(null), []);
  assert.deepEqual(citedShas(""), []);
  const many = Array.from({ length: 14 }, (_, i) => `a1b2c3${i.toString(16)}`).join(" ");
  assert.equal(citedShas(many).length, 10, "ten at most");
});

test("every cited sha on main reads live; a note with no sha reads as before", () => {
  const w = world();
  const none = cardState(card("built it, nothing else to say"), w.repo(), cfg, T);
  assert.equal(none.phase, "live");
  assert.equal(Object.hasOwn(none, "partsMissing"), false);
  const all = cardState(card(`parts ${w.base.slice(0, 7)} and ${w.sha}`), w.repo(), cfg, T);
  assert.equal(all.phase, "live", "base is an ancestor of main, the card's own commit is main");
  assert.equal(Object.hasOwn(all, "partsMissing"), false);
});

test("one missing sha holds the card below live and names that sha; a sha the repository cannot find counts as missing", () => {
  const w = world();
  const s = cardState(card(`parts ${w.base.slice(0, 7)} and ${w.side.slice(0, 9)}`), w.repo(), cfg, T);
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
  assert.equal(cardState(card(`parts ${landed.base.slice(0, 7)}`), landed.repo(), cfg, T).phase, "live");
});

test("a card that is not at live is not touched: a branch still in review keeps its phase, and partsMissing is only for the live case", () => {
  const w = world();
  const tips = [{ branch: "build/other-card", sha: w.side, at: T, message: "x\n\nBoard-Id: other-card" }]; // a card with no landing: its tip is the side commit, not on main
  const r = { ...w.repo(), tips };
  const s = cardState({ ...card(`part ${w.side.slice(0, 9)}`), id: "other-card" }, r, cfg, T);
  assert.notEqual(s.phase, "live");
  assert.equal(Object.hasOwn(s, "partsMissing"), false);
});
