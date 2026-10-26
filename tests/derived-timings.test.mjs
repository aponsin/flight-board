// #C235: each phase's times from the evidence (git, the sign-off notes, the deploy runs), so a card nobody logged
// steps for still shows when every phase ran; the page puts them in place of the steps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect } from "../collector/collect.mjs";
import { noteAt } from "../collector/timings.mjs";
import { loadNames, step } from "./harness.mjs";

const PATTERN = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})";
const T0 = 1_790_000_000; // seconds; every commit and note carries a set time
const at = (t) => (T0 + t) * 1000;
const iso = (t) => new Date(at(t)).toISOString();

// A scratch repository that ships like a real team: the work merged into a candidate branch, a version commit naming
// it, main moved to the candidate, then a deploy run on main.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-times-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let now = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${now} +0000`, GIT_AUTHOR_DATE: `${now} +0000` } });
  const when = (t) => { now = T0 + t; };
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const commit = (t, file, msg) => { when(t); writeFileSync(join(work, file), msg + "\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const note = (t, ref, sha) => { when(t); g(["notes", `--ref=${ref}`, "add", "-m", "PASS", sha]); };
  const sync = () => { g(["push", "-q", "--all", "--force", "origin"]); g(["push", "-q", "--force", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); g(["fetch", "-q", "--force", "origin", "+refs/notes/*:refs/notes/flight-board/*"]); };
  const start = commit(0, "a.md", "start");
  return { dir, g, when, commit, note, sync, start, git: (args) => g(args) };
}
const config = fullConfig({ owner: "Sam", collector: { repoPath: "/x", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI", shippedPattern: PATTERN, candidatePattern: "^build/ship-v" } });
const runsGh = (runs) => (args) => (args.includes("--workflow") ? JSON.stringify(runs) : "[]");

test("a card with no steps at all: every phase's start and end from the repository, the notes and the deploy run", () => {
  const r = repo();
  try {
    r.g(["checkout", "-qb", "build/timed"]);
    r.commit(100, "t.md", "wip");
    const head = r.commit(200, "t.md", "ready\n\nBoard-Id: timed");
    r.note(300, "refs/notes/checker", head);
    r.note(400, "refs/notes/security", head);
    r.g(["checkout", "-qb", "dev", "main"]);
    r.when(500); r.g(["merge", "-q", "--no-ff", "-m", `Merge commit '${head}' into dev`, head]);
    r.commit(510, "v.md", `v1.5.0: build/timed@${head.slice(0, 8)}`);
    r.g(["checkout", "-q", "main"]); r.g(["merge", "-q", "--ff-only", "dev"]);
    r.sync();
    const main = r.g(["rev-parse", "main"]).trim();
    const runs = [{ headSha: main, createdAt: iso(800), updatedAt: iso(980) }, { headSha: r.start, createdAt: iso(50), updatedAt: iso(90) }];
    const card = { id: "timed", status: "active", level: "Full", createdAt: at(20) };
    const { doc } = collect({ config, cards: [card], git: r.git, gh: runsGh(runs), now: at(1000) });
    assert.equal(doc.cards.timed.phase, "live");
    assert.deepEqual(doc.times.timed, {
      plan: { start: at(20), end: at(100) },
      build: { start: at(100), end: at(200) },
      checker: { start: at(200), end: at(300) },
      security: { start: at(300), end: at(400) },
      ship: { start: at(500), end: at(800) },
      live: { start: at(800), end: at(980) },
    });
    // Closed this week: still timed; closed long ago: left alone.
    const done = collect({ config, cards: [{ ...card, status: "done", doneAt: at(990) }], git: r.git, gh: runsGh(runs), now: at(1000) }).doc;
    assert.deepEqual(done.cards, {}, "a closed card gets no phase");
    assert.equal(done.times.timed.live.end, at(980));
    assert.deepEqual(collect({ config, cards: [{ ...card, status: "done", doneAt: at(990) }], git: r.git, gh: runsGh(runs), now: at(990) + 8 * 864e5 }).doc.times, {});
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("work under way: build open until READY; a review open from READY (or the note before) while it waits; ship open while a run has it", () => {
  const r = repo();
  try {
    r.g(["checkout", "-qb", "build/wip"]);
    r.commit(100, "w.md", "wip");
    r.commit(150, "w.md", "more wip");
    r.g(["checkout", "-qb", "build/one", "main"]);
    r.commit(160, "o.md", "one commit, not READY");
    r.g(["checkout", "-qb", "build/half", "main"]);
    r.commit(110, "h.md", "half");
    const half = r.commit(200, "h.md", "ready\n\nBoard-Id: half");
    r.note(300, "refs/notes/checker", half);
    r.g(["checkout", "-qb", "build/going", "main"]);
    const going = r.commit(120, "g.md", "go\n\nBoard-Id: going");
    r.note(130, "refs/notes/checker", going);
    r.note(140, "refs/notes/security", going);
    r.g(["checkout", "-qb", "build/ship-v1.6.0", "main"]);
    r.when(600); r.g(["merge", "-q", "--no-ff", "-m", `Merge commit '${going}' into dev`, going]);
    r.commit(610, "v.md", `v1.6.0: build/going@${going.slice(0, 8)}`);
    r.g(["checkout", "-q", "main"]);
    r.sync();
    const cards = ["wip", "one", "half", "going"].map((id) => ({ id, status: "active", level: "Full" }));
    const { doc } = collect({ config, cards, git: r.git, gh: runsGh([]), now: at(700) });
    assert.deepEqual(doc.times.wip, { build: { start: at(100), end: null } }, "no READY: build only, open");
    assert.equal(doc.times.one, undefined, "one commit says nothing of when the work began: the steps' to tell");
    assert.deepEqual(doc.times.half, { build: { start: at(110), end: at(200) }, checker: { start: at(200), end: at(300) }, security: { start: at(300), end: null } });
    assert.deepEqual(doc.times.going.ship, { start: at(600), end: null }, "the ship run merged it; main doesn't have it yet");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

// ---- The page ----
const MIN = 60e3, D0 = 1_792_900_000_000;
function page(times, steps = []) {
  const b = loadNames(["initRow", "enrich", "gates", "asShown"]);
  Object.assign(b.state, { steps, waiting: [] });
  b.state.derived.push({ id: "all", cards: {}, times });
  return b;
}
// The text under each phase's box: { Plan: "10 min", ... }.
function boxes(html) {
  const out = {};
  for (const m of html.matchAll(/<div class="step[^"]*" title="([^"]+)">\1<small([^>]*)>([^<]*)<\/small>/g)) out[m[1]] = m[2].includes("norec") ? `(${m[3]})` : m[3];
  return out;
}
const card = { id: "c", name: "C", status: "done", doneAt: D0 + 100 * MIN, level: "Full", customerText: false, version: "1.5.0" };

test("the page: a card with no steps at all shows every box's time from the evidence", () => {
  const b = page({ c: { plan: { start: D0, end: D0 + 10 * MIN }, build: { start: D0 + 10 * MIN, end: D0 + 40 * MIN }, checker: { start: D0 + 40 * MIN, end: D0 + 45 * MIN }, security: { start: D0 + 45 * MIN, end: D0 + 52 * MIN }, ship: { start: D0 + 60 * MIN, end: D0 + 68 * MIN }, live: { start: D0 + 68 * MIN, end: D0 + 71 * MIN } } });
  const shown = boxes(b.initRow(b.gates(b.enrich(b.asShown(card)))));
  assert.deepEqual(shown, { Plan: "10 min", Build: "30 min", Language: "not needed", Checker: "5 min", Security: "7 min", Ship: "8 min", Live: "3 min" });
});

test("the page: evidence beats a step that disagrees; a phase the evidence doesn't show keeps its steps", () => {
  const steps = [
    step("c", "build", "Builder", "start", D0), step("c", "build", "Builder", "end", D0 + 90 * MIN),
    step("c", "test", "Builder", "start", D0 + 90 * MIN, { id: "t1" }), step("c", "test", "Builder", "end", D0 + 94 * MIN, { id: "t2" }),
  ];
  const b = page({ c: { build: { start: D0 + 10 * MIN, end: D0 + 40 * MIN } } }, steps);
  const shown = boxes(b.initRow(b.gates(b.enrich(b.asShown(card)))));
  assert.equal(shown.Build, "30 min", "the repository's 30 minutes, not the steps' 90");
  assert.equal(shown.Test, "4 min", "no evidence for test: its steps");
  const open = b.enrich(b.asShown({ ...card, status: "active", doneAt: undefined }));
  assert.ok(open.phaseLog.some((e) => e.phase === "build" && e.evidence && e.who === "Builder"), "the steps' who stays with the evidence's entry");
});

test("the page: a finished phase with neither evidence nor a step says 'no record' in grey; skipped, ahead and live boxes don't", () => {
  const b = page({ c: { build: { start: D0 + 10 * MIN, end: D0 + 40 * MIN } } });
  const done = boxes(b.initRow(b.gates(b.enrich(b.asShown(card)))));
  assert.equal(done.Plan, "(no record)");
  assert.equal(done.Checker, "(no record)");
  assert.equal(done.Language, "not needed");
  assert.notEqual(done.Live, "(no record)", "live is where a card ends, not a phase with a length");
  const ahead = boxes(b.initRow(b.gates(b.enrich(b.asShown({ ...card, id: "d", status: "active", doneAt: undefined, phase: "checker" })))));
  assert.equal(ahead.Plan, "(no record)", "behind the card's phase");
  assert.notEqual(ahead.Ship, "(no record)", "ahead of it");
});

test("a head rewritten after its sign-off: READY is the first note; a deploy run read only after the head's own deploy says nothing", () => {
  const r = repo();
  try {
    r.g(["checkout", "-qb", "build/redo"]);
    r.commit(100, "r.md", "work");
    const head = r.commit(300, "r.md", "rewritten after the review\n\nBoard-Id: redo");
    r.note(200, "refs/notes/checker", head); // carried over from the commit that was signed
    r.g(["checkout", "-qb", "dev", "main"]);
    r.when(400); r.g(["merge", "-q", "--no-ff", "-m", `Merge commit '${head}' into dev`, head]);
    r.commit(410, "v.md", `v1.7.0: build/redo@${head.slice(0, 8)}`);
    r.g(["checkout", "-q", "main"]); r.g(["merge", "-q", "--ff-only", "dev"]);
    const later = r.commit(900, "z.md", "later work on main");
    r.sync();
    const card = { id: "redo", status: "active", level: "Quick" };
    // Only runs after its deploy were read: the oldest already has it.
    const late = collect({ config, cards: [card], git: r.git, gh: runsGh([{ headSha: later, createdAt: iso(950), updatedAt: iso(990) }]), now: at(1000) }).doc;
    assert.equal(late.cards.redo.phase, "live");
    assert.deepEqual(late.times.redo, { build: { start: at(100), end: at(200) } }, "READY moved back to the note (build ends at 200, not 300); the review has no length; ship and live unknown");
    // With the run before it read too, the first run that has it is found.
    const runs = [{ headSha: later, createdAt: iso(950), updatedAt: iso(990) }, { headSha: r.g(["rev-parse", "main~1"]).trim(), createdAt: iso(600), updatedAt: iso(700) }, { headSha: r.start, createdAt: iso(50), updatedAt: iso(60) }];
    const found = collect({ config, cards: [card], git: r.git, gh: runsGh(runs), now: at(1000) }).doc.times.redo;
    assert.deepEqual(found.ship, { start: at(400), end: at(600) });
    assert.deepEqual(found.live, { start: at(600), end: at(700) });
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a note's time is the time it was written; a sha that isn't one, or no note, reads nothing", () => {
  const r = repo();
  try {
    const sha = r.commit(10, "n.md", "n");
    r.note(20, "refs/notes/checker", sha);
    assert.equal(noteAt(r.git, "refs/notes/checker", sha), at(20));
    assert.equal(noteAt(r.git, "refs/notes/checker", "--all"), null);
    assert.equal(noteAt(r.git, "refs/notes/security", sha), null, "no note in that ref");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
