// #C1432 (11-24: #C1425 at 07bf808b and #C1431 at 007057e7 changed page/, Checker 2 and Security signed them, and the dispatch never sent them to Designer: the board repository's notes
// list had no design entry, so no board card ever waited for Designer, and Release's land refused for the missing LOOK-OK). A board card whose branch changes page/, or that is marked
// look_change, now waits for Designer, whose note the board's repository always reads; a page-free board card, and another repository's card, keep their reviews. Real git, fictional ids.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardState, boardRepoNotes, pageChanged } from "../collector/state.mjs";
import { turnsOf } from "../collector/store-dispatch.mjs";
import { DESIGNER_REF } from "../collector/signoff.mjs";

const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = () => ({ phases: [["plan"], ["build"], ["design"], ["checker"], ["security"], ["ship"], ["live"]], skips: [{ phase: "security", unlessLevel: "Full" }, { phase: "design", unlessTrue: "lookChange" }],
  collector: { notes: { design: "d", checker: "c", security: "s" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } });

// A scratch repository with one card commit changing `file`; notes as { role: text } on it; notes: the repository's note refs (the board's as the probe gives them).
function read(card, { file = "page/board.template.html", notes = {}, refs = boardRepoNotes("flight-board", NOTES), pageDiffFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-c1432-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
  git("commit", "-q", "--allow-empty", "-m", "base"); const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), "x\n"); git("add", "-A");
  const message = "Work (#C1432)\n\nBoard-Id: a-card";
  git("commit", "-q", "-m", message); const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/a-card", sha);
  const ref = { design: DESIGNER_REF, checker: NOTES.checker, security: NOTES.security };
  for (const [role, text] of Object.entries(notes)) git("notes", `--ref=${ref[role]}`, "add", "-m", text, sha);
  const T = Date.now();
  const tips = [{ branch: "a-card", sha, at: T, message }, { branch: "main", sha: main, at: T - 1000, message: "base" }];
  const gitFor = (args) => { if (pageDiffFails && args.at(-1) === "page/") throw new Error("diff failed"); return git(...args); };
  return cardState({ id: "a-card", num: 1432, level: "Quick", phase: "plan", repo: "flight-board", ...card }, { git: gitFor, remote: "origin", main: "main", notes: refs, tips, live: null, versionPattern: null }, cfg(), T);
}

test("boardRepoNotes: the board's repository reads Designer's note whatever its notes list; another repository keeps its own", () => {
  assert.deepEqual(boardRepoNotes("flight-board", NOTES), { ...NOTES, design: "refs/notes/designer" });
  assert.deepEqual(boardRepoNotes("board", NOTES).design, "refs/notes/designer", "the word board is the board's repository too");
  assert.deepEqual(boardRepoNotes("flight-board", { ...NOTES, design: "refs/notes/look" }).design, "refs/notes/look", "a design ref the config names stands");
  assert.deepEqual(boardRepoNotes("site-one", NOTES), NOTES, "another repository: as its config says");
  assert.deepEqual(boardRepoNotes("flight-board", undefined), { design: "refs/notes/designer" });
});

test("a board card whose branch changes page/ waits for Designer first; then Checker; then Security; its turn goes to Designer", () => {
  const e = read({});
  assert.equal(e.phase, "design");
  assert.deepEqual(e.waitingFor, ["design", "checker", "security"]);
  const turns = turnsOf({ id: "a-card", owner_role: "Boardsmith", repo: "flight-board" }, e);
  assert.deepEqual(turns.map((t) => [t.role, t.step]), [["Designer", "review"]], "the dispatch sends it to Designer");
  const looked = read({}, { notes: { design: "LOOK-OK (desktop and phone)" } });
  assert.deepEqual(looked.signed, ["design"]);
  assert.equal(looked.phase, "checker", "Designer's LOOK-OK signs it: Checker next");
  assert.equal(read({}, { notes: { design: "LOOK-OK", checker: "PASS", security: "SECURE" } }).phase, "ship");
  const sent = read({}, { notes: { design: "FINDINGS: F1 the badge overlaps" } });
  assert.deepEqual(sent.findings, ["design"], "Designer's FINDINGS sends it back");
});

test("a page-free board card does not wait for Designer unless it is marked look_change; Checker's PASS and SECURE take it to ship", () => {
  const plain = read({}, { file: "collector/x.mjs" });
  assert.equal(plain.phase, "checker");
  assert.equal(plain.waitingFor.includes("design"), false);
  assert.equal(read({}, { file: "collector/x.mjs", notes: { checker: "PASS", security: "SECURE" } }).phase, "ship");
  const marked = read({ lookChange: true }, { file: "collector/x.mjs" });
  assert.equal(marked.phase, "design", "look_change asks for Designer even with no page change (the config's design skip, read the other way round)");
  const noRef = read({}, { refs: NOTES });
  assert.equal(noRef.waitingFor.includes("design"), false, "a repository that reads no design note never waits for a review it could not see signed");
  const unread = read({}, { pageDiffFails: true });
  assert.equal(unread.waitingFor.includes("design"), false, "a page diff git can't read makes up no Designer review");
});

test("another repository's card keeps its config: a page/ change there asks nothing of Designer by itself", () => {
  const other = read({ repo: "site-one" }, { refs: boardRepoNotes("site-one", NOTES) });
  assert.equal(other.phase, "checker");
  assert.equal(other.waitingFor.includes("design"), false);
});

test("pageChanged: true, false, or null when git can't say", () => {
  const sha = "a".repeat(40);
  assert.equal(pageChanged({ git: () => "page/board.template.html\n" }, "origin/main", sha), true);
  assert.equal(pageChanged({ git: () => "" }, "origin/main", sha), false);
  assert.equal(pageChanged({ git: () => { throw new Error("no such commit"); } }, "origin/main", sha), null);
  assert.equal(pageChanged({ git: () => "page/x" }, "origin/main", "short"), null, "a sha that is not 40 hex is not asked");
  let asked = 0;
  const repo = { git: (args) => { asked++; assert.deepEqual(args.slice(-2), ["--", "page/"]); return "page/x\n"; } };
  pageChanged(repo, "origin/main", sha); pageChanged(repo, "origin/main", sha);
  assert.equal(asked, 1, "once per repository run and tip");
});

test("the probe's run gives every other repository its notes through boardRepoNotes", () => {
  const src = readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8");
  assert.match(src, /const at = repoAt\(home\(x\.path\), x\.remote \?\? "origin", x\.mainBranch \?\? "main", boardRepoNotes\(x\.name, x\.notes\)\);/);
});
