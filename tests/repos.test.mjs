// Cards in a second repository (#C278): the board's own cards live in flight-board, not in the team's product repository.
// Their state comes from that repository's branches and notes, and "installed" from the link the owner's install moves:
// signed but not on main is queued for a board release, on main but not installed waits for the install, installed is
// live. Neither wait is a stall. Fictional repositories and cards.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkConfig, fullConfig } from "../scripts/config.mjs";
import { collect, repoOf } from "../collector/collect.mjs";
import { nudges } from "../collector/nudges.mjs";

const BOARD = { name: "flight-board", path: "/srv/fb-repo", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, idPrefixes: ["board-"], installedLink: "/srv/fb/current" };

function scratchBoard() {
  const dir = mkdtempSync(join(tmpdir(), "fb-repos-"));
  const repo = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (file, msg) => { writeFileSync(join(repo, file), msg + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sign = (sha, ...who) => { for (const w of who) g(["notes", `--ref=refs/notes/${w}`, "add", "-m", w === "security" ? "SECURE" : "PASS", sha]); };
  commit("a.md", "start");
  // Live: merged, and the install moved past it.
  g(["checkout", "-qb", "board-live"]); const live = commit("l.md", "live work\n\nBoard-Id: board-live"); sign(live, "checker", "security");
  g(["checkout", "-q", "main"]); g(["merge", "-q", "--ff-only", "board-live"]);
  const installed = g(["rev-parse", "HEAD"]).trim();
  // Waiting for the install: merged after it.
  g(["checkout", "-qb", "board-waiting"]); const waiting = commit("w.md", "waiting work\n\nBoard-Id: board-waiting"); sign(waiting, "checker", "security");
  g(["checkout", "-q", "main"]); g(["merge", "-q", "--ff-only", "board-waiting"]);
  // Queued for a board release: signed, not on main.
  g(["checkout", "-qb", "board-queued"]); const queued = commit("q.md", "queued work\n\nBoard-Id: board-queued"); sign(queued, "checker", "security");
  // In review: READY, Security not yet.
  g(["checkout", "-qb", "board-review", "main"]); const review = commit("r.md", "review work\n\nBoard-Id: board-review"); sign(review, "checker");
  g(["checkout", "-q", "main"]);
  g(["push", "-q", "origin", "main", "board-live", "board-waiting", "board-queued", "board-review", "refs/notes/checker", "refs/notes/security"]);
  g(["fetch", "-q", "origin", "+refs/notes/*:refs/notes/flight-board/*"]);
  g(["fetch", "-q", "origin"]);
  return { dir, git: (args) => g(args), installed };
}

test("config: collector.repos, each a name, a folder, notes per review phase, the card ids it holds and the link that says installed", () => {
  assert.deepEqual(checkConfig({ collector: { repos: [BOARD] } }), []);
  assert.deepEqual(fullConfig({}).collector.repos, []);
  for (const bad of [{ ...BOARD, name: "Two Words" }, { ...BOARD, path: "" }, { ...BOARD, notes: { nope: "refs/notes/x" } }, { ...BOARD, idPrefixes: "board-" }, { ...BOARD, mainBranch: "a b" }, { ...BOARD, extra: 1 }])
    assert.match(checkConfig({ collector: { repos: [bad] } }).join(), /collector\.repos/, JSON.stringify(bad));
  assert.match(checkConfig({ collector: { repos: [BOARD, BOARD] } }).join(), /each name once/);
});

test("a card's repository: its own repo field, else the first whose id prefix it carries, else the team's", () => {
  const config = fullConfig({ collector: { repos: [BOARD] } });
  assert.equal(repoOf({ id: "board-release" }, config)?.name, "flight-board");
  assert.equal(repoOf({ id: "menu-fix", repo: "flight-board" }, config)?.name, "flight-board");
  assert.equal(repoOf({ id: "menu-fix" }, config), null, "the team's own repository");
  assert.equal(repoOf({ id: "board-x", repo: "elsewhere" }, config), null, "an unknown repo field is the team's");
});

test("signed, not on main: queued for a board release; on main, not installed: waiting for the install; installed: live", () => {
  const s = scratchBoard();
  try {
    const config = fullConfig({ collector: { repoPath: "/srv/team", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, repos: [BOARD] } });
    const none = (args) => { if (args[0] === "for-each-ref") return ""; if (args[0] === "log") return ""; throw new Error("no repo"); };
    const cards = ["board-live", "board-waiting", "board-queued", "board-review"].map((id) => ({ id, status: "active", phase: "build", level: "Full" }));
    const { doc } = collect({ config, cards: [...cards, { id: "menu-fix", status: "active", phase: "build" }], git: none, gh: () => "[]", now: 5, repos: { "flight-board": { git: s.git, installed: s.installed } } });
    assert.equal(doc.cards["board-live"].phase, "live");
    assert.equal(doc.cards["board-live"].wait, undefined);
    assert.deepEqual([doc.cards["board-waiting"].phase, doc.cards["board-waiting"].wait], ["ship", "install"]);
    assert.deepEqual([doc.cards["board-queued"].phase, doc.cards["board-queued"].wait], ["ship", "release"]);
    assert.deepEqual([doc.cards["board-review"].phase, doc.cards["board-review"].wait], ["security", undefined]);
    for (const id of ["board-live", "board-waiting", "board-queued", "board-review"]) assert.equal(doc.cards[id].repo, "flight-board");
    assert.equal(doc.cards["menu-fix"].phase, null, "the team's card is read from the team's repository");
    // A repository that couldn't be read leaves its cards as declared, never guessed.
    const missing = collect({ config, cards, git: none, gh: () => "[]", now: 5, repos: {} }).doc;
    assert.equal(missing.cards["board-queued"].phase, null);
    assert.match(missing.cards["board-queued"].evidence, /flight-board.*not read/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test("nudges: a card in a known wait gets no step-overdue or unchanged nudge", () => {
  const HOUR = 3600e3, now = 100 * HOUR;
  const config = fullConfig({});
  const docs = { initiatives: [{ id: "board-queued", status: "active", size: "S" }], steps: [{ id: "s1", init: "board-queued", phase: "ship", who: "Release", kind: "start", at: now - 50 * HOUR }], ctx: [] };
  assert.match(nudges({ config, docs, now }).lines.join("\n"), /board-queued/, "without the wait, it nudges");
  assert.equal(nudges({ config, docs, now, waiting: new Set(["board-queued"]) }).lines.join("\n"), "");
  // Unchanged for a day while waiting: no nudge either.
  const first = nudges({ config, docs: { ...docs, steps: [] }, now: now - 30 * HOUR });
  assert.match(nudges({ config, docs: { ...docs, steps: [] }, now, state: first.state }).lines.join("\n"), /unchanged/);
  assert.equal(nudges({ config, docs: { ...docs, steps: [] }, now, state: first.state, waiting: new Set(["board-queued"]) }).lines.join("\n"), "");
});
