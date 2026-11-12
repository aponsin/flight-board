// #C996 part 3: the per-card sign-off read costs one `git notes list` per review ref per run, not a `notes show` per card per ref.
// A card no review has seen spawns no show; a signed card still reads its note; the count is the same for 4 cards as for 16.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { cardState, annotatedOn } from "../collector/state.mjs";

const T0 = 1_790_000_000;
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const cfg = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: NOTES, deployWorkflow: "CI" } });
const sha = (n) => String(n).padStart(40, "a");
const SIGNED = sha(1);

function run(count) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "notes" && args[2] === "list") return args[1] === "--ref=refs/notes/checker" ? `${"b".repeat(40)} ${SIGNED}\n` : `${"c".repeat(40)} ${sha(7)}\n`;
    if (args[0] === "notes" && args[2] === "show") { if (args[3] === SIGNED && args[1] === "--ref=refs/notes/checker") return "PASS\n"; throw new Error("no note"); }
    throw new Error("unfaked: " + args.join(" "));
  };
  const repo = { git, remote: "origin", main: "main", notes: NOTES, live: null, versionPattern: null, tips: [] };
  const states = [];
  for (let i = 0; i < count; i++) {
    const s = i === 0 ? SIGNED : sha(100 + i);
    const msg = `Work\n\nBoard-Id: card-${i}`;
    repo.tips = [{ branch: `origin/card-${i}`, sha: s, at: (T0 + 10) * 1000, message: msg }];
    states.push(cardState({ id: `card-${i}`, num: 900 + i, level: "Full", phase: "plan" }, repo, cfg, T0 * 1000));
  }
  return { calls, states };
}

test("annotatedOn reads a ref once and trusts only a non-empty list", () => {
  let n = 0;
  const repo = { git: () => { n++; return `${"b".repeat(40)} ${SIGNED}\n`; } };
  assert.ok(annotatedOn(repo, "refs/notes/x").has(SIGNED));
  annotatedOn(repo, "refs/notes/x");
  assert.equal(n, 1, "second read comes from the memo");
  assert.equal(annotatedOn({ git: () => "" }, "refs/notes/x"), null, "an empty list is not trusted");
  assert.equal(annotatedOn({ git: () => { throw new Error("x"); } }, "refs/notes/x"), null);
});

test("the notes spawn count is the same for 4 cards as for 16", () => {
  const count = (n) => run(n).calls.filter((c) => c.startsWith("notes ")).length;
  assert.equal(count(16), count(4) + 0, "list once per ref, show only for the signed card");
});

test("an unseen tip spawns no notes show, and a signed one still reads its note", () => {
  const { calls } = run(1);
  assert.ok(calls.some((c) => c === `notes --ref=refs/notes/checker show ${SIGNED}`), "the signed tip is read");
  assert.ok(!calls.some((c) => c === `notes --ref=refs/notes/security show ${SIGNED}`), "the ref without a note on it is not asked");
});
