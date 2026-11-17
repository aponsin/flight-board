// #C1102 (the owner, 2026-11-16:the board shows a builder's work within 2 minutes of the commit; a group reads "building" only for real work):
// (a) the post-commit hook pushes a build/ branch at once (tests/post-commit-push.test.mjs); (b) the pushed branch is the card's build, read by the probe on its next run;
// (c) the push wakes no reviewer (#C1066); (d) a card whose head carries the stack-ready waiting note is built and held: the probe's builtWaiting, the page's "Built, waiting"
// (tests/group-pulses-only-when-worked.test.mjs). This file: the probe on real git, the schema, and the store's evidence path.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cardStates, remoteTips } from "../collector/state.mjs";
import { STACK_HOLD_FROM } from "../collector/stack.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { probeDoc } from "../worker/compat-view.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence } from "../worker/board-store.mjs";

const T0 = STACK_HOLD_FROM / 1000 + 10_000;
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI" } });
const WAITING = "refs/notes/flight-board/stack-ready-waiting", READY = "refs/notes/flight-board/stack-ready";
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-c1102-")), work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  writeFileSync(join(work, "base.md"), "start\n"); g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const commit = (t, file, id) => { at = T0 + t; appendFileSync(join(work, file), `${t}\n`); g(["add", "-A"]); g(["commit", "-qm", `Work on ${id}\n\nBoard-Id: ${id}`]); return g(["rev-parse", "HEAD"]).trim(); };
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["fetch", "-q", "--prune", "origin"]); };
  const repo = () => ({ git: (args) => g(args), remote: "origin", main: "main", notes: cfg.collector.notes, tips: remoteTips((a) => g(a), "origin"), live: null, versionPattern: null });
  const note = (ref, sha) => g(["notes", `--ref=${ref}`, "add", "-f", "-m", "x", sha]);
  const states = (ids) => cardStates({ cards: ids.map((id) => ({ id })), config: cfg, repos: { "": repo() }, now: (T0 + 100) * 1000, stacks: [""] });
  return { g, commit, sync, note, states };
}
const branch = (s, id, t = 10) => { s.g(["checkout", "-qb", `build/${id}`]); const head = s.commit(t, "a.md", id); s.g(["checkout", "-q", "main"]); s.sync(); return head; };

test("(b) a pushed WIP branch is the card's build on the next probe run: a head, stackHold, and no builtWaiting", () => {
  const s = scratch();
  branch(s, "solo");
  const r = s.states(["solo"]).solo;
  assert.equal(typeof r.headSha12, "string");
  assert.equal(r.stackHold, true);
  assert.equal(r.builtWaiting, undefined, "a WIP push is building, not built");
});

test("(d) a head carrying the waiting note reads builtWaiting; a later push has no note and reads as building; a READY signal on the head clears both", () => {
  const s = scratch();
  const head = branch(s, "solo");
  s.note(WAITING, head);
  const waiting = s.states(["solo"]).solo;
  assert.equal(waiting.stackHold, true, "still held: a waiting note is no signal");
  assert.equal(waiting.builtWaiting, true);
  assert.deepEqual(stateErrors({ v: 1, id: "t", cards: { k: waiting } }).filter((e) => e.startsWith("cards.k")), [], "the reading passes the schema");
  s.g(["checkout", "-q", "build/solo"]); s.commit(40, "a.md", "solo"); s.g(["checkout", "-q", "main"]); s.sync();
  const later = s.states(["solo"]).solo;
  assert.equal(later.stackHold, true);
  assert.equal(later.builtWaiting, undefined, "a push after the wait has no note: building again");
  const t = scratch();
  const h2 = branch(t, "solo");
  t.note(WAITING, h2); t.note(READY, h2);
  const covered = t.states(["solo"]).solo;
  assert.equal(covered.stackHold, undefined);
  assert.equal(covered.builtWaiting, undefined, "the signal covers it: neither flag");
});

test("(d) the schema accepts builtWaiting: true only", () => {
  const base = { phase: "build", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, lit: ["build"], at: 1 };
  const errs = (extra) => stateErrors({ v: 1, id: "t", cards: { k: { ...base, ...extra } } }).filter((e) => e.startsWith("cards.k") && /builtWaiting/.test(e));
  assert.deepEqual(errs({ builtWaiting: true }), []);
  assert.notDeepEqual(errs({ builtWaiting: false }), []);
  assert.notDeepEqual(errs({ builtWaiting: "yes" }), []);
});

test("(d) the store keeps builtWaiting in the card's evidence and the page's probe document carries it", async () => {
  const db = makeDb(), T = 1_800_000_000_000;
  await createCard(db, T, "Manager", { id: "c", title: "A card", owner_role: "Boardsmith" });
  const w = await writeEvidence(db, T + 1, "probe", "cards.c", { lit: ["build"], phase: "build", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false, stackHold: true, builtWaiting: true });
  assert.ok(w === undefined || w.ok !== false, "the Worker accepts the field");
  const row = await db.prepare("SELECT value FROM evidence WHERE key = 'cards.c'").first();
  assert.equal(JSON.parse(row.value).builtWaiting, true);
  const doc = probeDoc({ now: T + 2, cards: [{ id: "c" }], evidence: { "cards.c": { value: JSON.parse(row.value) } } });
  assert.equal(doc.cards.c.builtWaiting, true);
});
