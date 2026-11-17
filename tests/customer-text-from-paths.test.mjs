// #C1110: a branch that touches the repository's customer-text paths (the reviewPaths table's language list) sets the card's customer_text flag, with
// no one ticking a box. The probe reads it (cardState: customerText true); the Worker raises the flag and never clears it. Real git; fictional names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { cardState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, writeEvidence } from "../worker/board-store.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const TABLE = { language: ["strings/**", "templates/*.html"] };

function scratch(files, table = TABLE) {
  const dir = mkdtempSync(join(tmpdir(), "fb-ctext-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${T0} +0000`, GIT_AUTHOR_DATE: `${T0} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  g(["checkout", "-qb", "card-t"]);
  for (const f of files) { const p = join(work, f); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "x\n"); }
  g(["add", "-A"]); g(["commit", "-qm", "Work\n\nBoard-Id: card-t"]);
  const sha = g(["rev-parse", "HEAD"]).trim(); g(["checkout", "-q", "main"]);
  g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]);
  const repo = { git: (args) => g(args), remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, ...(table ? { reviewPaths: table } : {}),
    tips: [{ branch: "main", sha: "x", at: T0, message: "" }, { branch: "origin/card-t", sha, at: T0 * 1000, message: "Work\n\nBoard-Id: card-t" }] };
  return () => cardState({ id: "card-t", num: 1110, level: "Quick", phase: "plan" }, repo, cfg, T0 * 1000);
}

test("a branch that touches a strings file reads customerText true, and the state fits the schema", () => {
  const st = scratch(["strings/en.json"])();
  assert.equal(st.customerText, true);
  assert.deepEqual(stateErrors({ v: 1, board: { boardId: "b", at: T0 * 1000, probe: null, pageVersion: null }, cards: { "card-t": st }, agents: {} }), []);
});

test("a template change counts too; a test-only or docs change does not", () => {
  assert.equal(scratch(["templates/mail.html"])().customerText, true);
  assert.ok(!("customerText" in scratch(["tests/strings.test.mjs"])()), "a test-only change leaves the word out");
  assert.ok(!("customerText" in scratch(["docs/notes.md"])()));
});

test("a repository with no reviewPaths table says nothing about customer text", () => {
  assert.ok(!("customerText" in scratch(["strings/en.json"], null)()));
  assert.ok(!("customerText" in scratch(["strings/en.json"], { security: ["worker/**"] })()), "a table with no language list says nothing either");
});

const rd = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, ...extra });
const flag = async (db) => (await db.prepare("SELECT customer_text AS c FROM cards WHERE id = 'a-card'").first()).c;

test("the Worker sets customer_text from a reading and never clears it; a hand-set true or false is raised only from null or 0", async () => {
  const db = makeDb();
  await createCard(db, 1_800_000_000_000, "Manager", { id: "a-card", title: "A card", owner_role: "Builder" });
  assert.ok(!(await flag(db)), "nothing set at card time");
  await writeEvidence(db, 1_800_000_001_000, "probe", "cards.a-card", rd({ customerText: true }));
  assert.equal(await flag(db), 1);
  await writeEvidence(db, 1_800_000_002_000, "probe", "cards.a-card", rd({ headSha12: "bbbbbbbbbbbb" }));
  assert.equal(await flag(db), 1, "a later reading without the word does not clear it");
  const db2 = makeDb();
  await createCard(db2, 1_800_000_000_000, "Manager", { id: "a-card", title: "A card", owner_role: "Builder", customer_text: false });
  await writeEvidence(db2, 1_800_000_001_000, "probe", "cards.a-card", rd({ customerText: true }));
  assert.equal(await flag(db2), 1, "a card typed false is raised by the paths");
  assert.equal((await updateCard(db2, 1_800_000_003_000, "Manager", { id: "a-card", customer_text: true })).ok, true);
});
