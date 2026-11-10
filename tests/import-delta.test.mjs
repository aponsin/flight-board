// The C5 delta import (#C741): which cards the store lacks, which are the board's own (from git), and the SQL for them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idsOf, boardIdsFromGit, planDelta, deltaSql, report } from "../collector/import-delta.mjs";

const card = (num, extra = {}) => ({ num, name: `Card ${num}`, summary: "s", size: "S", level: "Full", who: "Boardsmith", status: "active", createdAt: 1000 + num, ...extra });

test("Board-Id lines are read from the whole message, a trailer block or not; other lines and ids are not", () => {
  const text = "Subject\n\nbody\nBoard-Id: c1-a\n\nCo-Authored-By: x\n---\nBoard-Id: c2-b  \nBoard-Id: UPPER\nBoard-Id:\n  Board-Id: c3-indented\nsee Board-Id: c4-inline";
  assert.deepEqual([...idsOf(text)].sort(), ["c1-a", "c2-b"]);
});

test("the board's cards are the ones with a Board-Id on origin/main or on the tip of an origin build/ branch", () => {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "log" && args[1] === "origin/main") return "x\n\nBoard-Id: on-main\n";
    if (args[0] === "for-each-ref") return "refs/remotes/origin/build/branch-a\nrefs/remotes/origin/build/branch-b-v2\n";
    return args.at(-1).endsWith("branch-a") ? "Board-Id: not-landed\n" : "no id here\n";
  };
  assert.deepEqual([...boardIdsFromGit(git)].sort(), ["not-landed", "on-main"]);
  assert.ok(calls.some((c) => c.startsWith("for-each-ref") && c.includes("refs/remotes/origin/build/")));
});

test("real git: a commit message with the id (even after a blank line) counts, and nothing else does", () => {
  const dir = mkdtempSync(join(tmpdir(), "delta-"));
  const g = (...a) => execFileSync("git", ["-C", dir, "-c", "user.email=t@e.x", "-c", "user.name=t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  g("init", "-q", "-b", "main"); writeFileSync(join(dir, "f"), "1"); g("add", "f");
  g("commit", "-q", "-m", "a change\n\nBoard-Id: real-card\n\nCo-Authored-By: someone");
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.deepEqual([...boardIdsFromGit((args) => g(...args))], ["real-card"]);
});

test("a card the store lacks is inserted with its number and, if it is the board's, the repo word; a team card gets none", () => {
  const p = planDelta({ "c730-x": card(730), "c722-y": card(722) }, { boardIds: new Set(["c730-x"]) });
  assert.deepEqual(p.insert.map((r) => [r.id, r.num, r.repo]), [["c722-y", 722, undefined], ["c730-x", 730, "flight-board"]]);
  assert.deepEqual(p.teamCards.map((c) => c.id), ["c722-y"]);
  assert.equal(p.counterC, 731);
});

test("a card the store holds only gets the repo word, if it is the board's; nothing else is touched", () => {
  const p = planDelta({ "c719-a": card(719), "c722-y": card(722) }, { boardIds: new Set(["c719-a"]), storeIds: new Set(["c719-a", "c722-y"]) });
  assert.deepEqual(p.insert, []);
  assert.deepEqual(p.setRepo, [{ id: "c719-a", repo: "flight-board" }]);
  const sql = deltaSql(p);
  assert.match(sql, /UPDATE cards SET repo = 'flight-board' WHERE id = 'c719-a' AND repo IS NULL;/);
  assert.doesNotMatch(sql, /INSERT/);
  assert.doesNotMatch(sql, /c722-y/);
});

test("cards below the starting number are left alone; a done card is a history row, not a card; a refused card is listed", () => {
  const docs = { "old-one": card(100), "done-one": card(740, { status: "done", doneAt: 5000 }), "bad id!": card(745), "no-title": { ...card(746), name: "" } };
  const p = planDelta(docs, {});
  assert.equal(p.skipped.belowNum, 1);
  assert.deepEqual(p.history.map((h) => h.id), ["done-one"]);
  assert.deepEqual(p.insert, []);
  assert.deepEqual(p.refused.map((r) => r.id).sort(), ["bad id!", "no-title"]);
  assert.equal(planDelta({ "done-one": docs["done-one"] }, { historyIds: new Set(["done-one"]) }).history.length, 0);
});

test("a dropped card is never a history row, even when its status says done (Checker)", () => {
  const p = planDelta({ "gone-one": card(740, { status: "done", doneAt: 5000, dropped: true }) }, {});
  assert.deepEqual(p.history, []);
  assert.deepEqual(p.insert, []);
});

test("run as a script from a path with a space in it, the dry run still starts (it asks for its arguments, exit 64)", async () => {
  const { symlinkSync, mkdirSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const dir = join(mkdtempSync(join(tmpdir(), "delta space ")), "a b");
  mkdirSync(dir);
  const link = join(dir, "import-delta.mjs");
  symlinkSync(fileURLToPath(new URL("../collector/import-delta.mjs", import.meta.url)), link);
  const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
  assert.equal(r.status, 64, r.stderr);
  assert.match(r.stderr, /pass --export/);
});

test("the SQL is by old id and idempotent in form: INSERT OR IGNORE, a guarded repo UPDATE, and a counter that only goes up; quotes are escaped", () => {
  const p = planDelta({ "c730-x": card(730, { name: "It's a card", summary: "O'Neil" }) }, { boardIds: new Set(["c730-x"]) });
  const sql = deltaSql(p);
  assert.match(sql, /^INSERT OR IGNORE INTO cards \(/m);
  assert.match(sql, /'It''s a card'/);
  assert.match(sql, /UPDATE counters SET next = MAX\(next, 731\) WHERE name = 'C';/);
  assert.equal(report(p).insert[0].repo, "flight-board");
});

test("a bad repo word is refused before anything is planned", () => {
  assert.throws(() => planDelta({}, { repoWord: "Flight Board" }), /repo word/);
});

test("a number that is not an integer from 1 to 1e6 is refused, never inserted, never counted (Security 1)", () => {
  const docs = { "huge-one": card(1e300), "frac-one": card(740.5), "neg-one": card(-5), "zero-one": card(0), "edge-one": card(1e6), "over-one": card(1e6 + 1), "none-one": { ...card(741), num: undefined } };
  const p = planDelta(docs, { storeIds: new Set(["huge-one", "over-one"]), boardIds: new Set(["huge-one", "over-one"]) });
  assert.deepEqual(p.refused.map((r) => r.id).sort(), ["frac-one", "huge-one", "neg-one", "over-one", "zero-one"]);
  assert.ok(p.refused.every((r) => r.detail === "number out of range"));
  assert.deepEqual(p.insert.map((r) => r.id), ["edge-one"]);
  assert.deepEqual(p.setRepo, []);
  assert.equal(p.skipped.belowNum, 1);
  assert.equal(p.counterC, 1e6 + 1);
  assert.doesNotMatch(deltaSql(p), /e\+/);
  const hist = planDelta({ "huge-done": card(1e300, { status: "done", doneAt: 5000 }) }, {});
  assert.deepEqual(hist.history, []);
  assert.equal(hist.refused.length, 1);
  assert.equal(hist.counterC, 0);
});

test("a control character other than tab and newline never reaches the SQL: the card is refused, and q() throws as a backstop (Security 2)", () => {
  const p = planDelta({ "nul-one": card(740, { name: "a\u0000b" }), "esc-one": card(741, { summary: "x\u001b[0m" }), "ok-one": card(742, { name: "tab\there\nline" }), "nul-done": card(743, { status: "done", doneAt: 5000, name: "d\u0000" }) }, {});
  assert.deepEqual(p.refused.map((r) => r.id).sort(), ["esc-one", "nul-done", "nul-one"]);
  assert.deepEqual(p.insert.map((r) => r.id), ["ok-one"]);
  assert.deepEqual(p.history, []);
  assert.doesNotThrow(() => deltaSql(p));
  assert.throws(() => deltaSql({ insert: [{ id: "x", title: "a\u0000b" }], history: [], setRepo: [], counterC: 1 }), /control character/);
  assert.throws(() => deltaSql({ insert: [], history: [], setRepo: [{ id: "x", repo: "a\u007f" }], counterC: 1 }), /control character/);
});

test("a done card's file-name id passes the card-id rule too (Security 3)", () => {
  const p = planDelta({ "h'); DELETE FROM cards; --": card(740, { status: "done", doneAt: 5000 }), "fine-done": card(741, { status: "done", doneAt: 5000 }) }, {});
  assert.deepEqual(p.history.map((h) => h.id), ["fine-done"]);
  assert.deepEqual(p.refused.map((r) => r.rule), ["card-id"]);
});
