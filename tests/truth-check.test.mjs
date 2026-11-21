// #C1386 (the audit's point 4, contract B4): the truth check asks git its own questions per card and compares the answers with the stored reading. These tests build a REAL
// repository (a behind-a-merge card, a docs-only landing, a cherry-picked landing, review notes, a pair folder), and prove: clean readings agree; each wrong reading is one named
// difference with both values; a difference is reported only on its second run in a row; an answer git could not give is never a difference; the file imports nothing that feeds the
// evidence; the step never fails the job; and the whole chain (state.mjs -> reading.mjs -> the check) catches the --first-parent bug of #C1376 when it is put back.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, cpSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { askGit, compare, truthJob, readPairs, defaultGit, pickReadings, gatherFacts, RUNS_TO_REPORT, CARD_CAP, UNREAD } from "../collector/truth-check.mjs";
import { truthStep, truthStep as truthStepFromEvidence } from "../collector/probe-evidence.mjs";
import { cardState } from "../collector/state.mjs";
import { reading as readingOf } from "../worker/reading.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PATTERN = "^v(\\d+\\.\\d+\\.\\d+)\\b";
const NOTES = { checker: "refs/notes/checker", security: "refs/notes/security" };
const LATER = Date.now() + 2 * 3_600_000; // the clock the facts are asked at: every version commit of the fixture is older than the settle window

// main: base, v1.0.1, the merge of a group head over the card (the card sits BEHIND the merge), v1.0.2, then board cards: B (packed, installed), Q (packed, not installed), D (docs
// only), P (not packed), S' (a cherry-pick of a branch commit S). Branches off main hold N (signed), F (FINDINGS), L (not landed).
function build() {
  const dir = mkdtempSync(join(tmpdir(), "fb-truth-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "gc.auto", "0");
  const commit = (path, msg) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), `${path}\n${msg}\n`); git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  const s = {};
  s.base = commit("a.txt", "base");
  s.v0 = commit("b.txt", `v1.0.1: admin/an-older-card@${s.base}`);
  git("checkout", "-q", "-b", "admin/c-card", s.v0);
  s.card = commit("c.txt", "The card's work\n\nBoard-Id: c-card");
  git("checkout", "-q", "-b", "admin/g-mate", s.card);
  s.head = commit("d.txt", "A groupmate's work, above it");
  git("checkout", "-q", "-b", "admin/s-card", s.v0);
  s.S = commit("s.txt", "S work\n\nBoard-Id: s-card");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `Merge commit '${s.head}' into dev`, s.head);
  s.merged = git("rev-parse", "HEAD");
  s.V = commit("ver.txt", `v1.0.2: admin/g-mate@${s.head}`);
  s.B = commit("collector/b.mjs", "B work\n\nBoard-Id: b-card");
  s.Q = commit("collector/q.mjs", "Q work\n\nBoard-Id: q-card");
  s.D = commit("docs/x.md", "D docs\n\nBoard-Id: doc-card");
  s.P = commit("collector/p.mjs", "P work\n\nBoard-Id: p-card");
  git("cherry-pick", s.S);
  s.S2 = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", s.S2);
  for (const [name, file] of [["n-card", "n.txt"], ["f-card", "f.txt"], ["l-card", "l.txt"]]) {
    git("checkout", "-q", "-b", `admin/${name}`, s.P);
    s[name[0].toUpperCase()] = commit(file, `${name} work\n\nBoard-Id: ${name}`);
  }
  git("checkout", "-q", "main");
  git("notes", "--ref=refs/notes/flight-board/checker", "add", "-m", "PASS: read the diff", s.N);
  git("notes", "--ref=refs/notes/flight-board/security", "add", "-m", "SECURE: nothing found", s.N);
  git("notes", "--ref=refs/notes/flight-board/checker", "add", "-m", "FINDINGS: one real one\n\nmore", s.F);
  // The pair folder: pc5 holds B and ran; pc6 holds Q and has not run.
  const pairFolder = join(dir, ".pairs");
  mkdirSync(pairFolder);
  const pair = (n, sha, ran) => { writeFileSync(join(pairFolder, `board-store-deploy-pc${n}.mjs`), `export const x = 1;\nconst SIGNED = "${sha}";\n`); if (ran) writeFileSync(join(pairFolder, `board-store-deploy-pc${n}.done`), `${sha}\n`); };
  pair(5, s.B, true); pair(6, s.Q, false);
  return { dir, s, git, pairFolder, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const HEADS = (s) => ({ "c-card": s.card, "b-card": s.B, "q-card": s.Q, "doc-card": s.D, "p-card": s.P, "s-card": s.S, "n-card": s.N, "f-card": s.F, "l-card": s.L });
const KINDS = { "c-card": "product" };
function ask(fx, id, over = {}) {
  const pairs = readPairs(fx.pairFolder);
  return askGit({ id, headSha: HEADS(fx.s)[id], kind: KINDS[id] ?? "board", dir: fx.dir, remote: "origin", main: "main", notes: NOTES, versionPattern: PATTERN, ...over }, { git: defaultGit, pairs, workerSha: fx.s.Q, treeSha: fx.s.Q, now: LATER, ...(over.deps ?? {}) });
}
const R = (id, over) => ({ id, num: 100 + Object.keys(HEADS({})).length, phase: "ship", state: "waiting", wait: null, with: "Release", working: false, ...over });
// The readings a clean board has for the fixture.
const clean = () => [
  R("c-card", { num: 1315, phase: "live", state: "done", repo: "shop" }),
  R("b-card", { num: 1, phase: "live", state: "done" }),
  R("doc-card", { num: 2, phase: "live", state: "done" }),
  R("q-card", { num: 3, wait: "install" }),
  R("p-card", { num: 4, wait: "pack" }),
  R("s-card", { num: 5, wait: "pack" }),
  R("n-card", { num: 6, phase: "checker" }),
  R("f-card", { num: 7, phase: "checker", state: "rework" }),
  R("l-card", { num: 8, wait: "land" }),
];
const facts = (fx) => Object.fromEntries(Object.keys(HEADS(fx.s)).map((id) => [id, ask(fx, id)]));
const differences = (fx, readings, f = facts(fx)) => readings.flatMap((r) => compare(r, f[r.id], { now: LATER }).map((d) => ({ card: r.id, ...d })));
const withReading = (readings, id, over) => readings.map((r) => (r.id === id ? { ...r, ...over } : r));

test("the facts: a commit behind a merge is on main and inside its version, a docs landing needs no deploy, a cherry-pick is found by its trailer and subject", () => {
  const fx = build();
  try {
    const f = facts(fx);
    assert.deepEqual([f["c-card"].onMain, f["c-card"].deployed, f["c-card"].version], [true, true, "1.0.2"]);
    assert.deepEqual([f["b-card"].onMain, f["b-card"].deployed, f["b-card"].packed, f["b-card"].installed], [true, true, true, true]);
    assert.deepEqual([f["q-card"].packed, f["q-card"].installed], [true, false]);
    assert.deepEqual([f["p-card"].deployed, f["p-card"].packed], [false, false]);
    assert.deepEqual([f["doc-card"].docsOnly, f["doc-card"].deployed], [true, true]);
    assert.deepEqual([f["s-card"].onMain, f["s-card"].landing], [true, fx.s.S2]);
    assert.equal(f["l-card"].onMain, false);
    assert.deepEqual(f["n-card"].notes, { findings: [], signed: ["checker", "security"], stops: [] });
    assert.deepEqual(f["f-card"].notes, { findings: ["checker"], signed: [], stops: [] });
  } finally { fx.done(); }
});

test("clean readings give no difference", () => {
  const fx = build();
  try { assert.deepEqual(differences(fx, clean()), []); } finally { fx.done(); }
});

test("each wrong reading is exactly one named difference with both values", () => {
  const fx = build();
  try {
    const one = (readings) => { const d = differences(fx, readings); assert.equal(d.length, 1, JSON.stringify(d)); return d[0]; };
    // done for a card that is not on main
    assert.deepEqual(one(withReading(clean(), "l-card", { state: "done", wait: null, phase: "live" })), { card: "l-card", field: "onMain", reading: "done", git: "not on main" });
    // done for a card main holds but no deploy does
    assert.deepEqual(one(withReading(clean(), "p-card", { state: "done", wait: null, phase: "live" })), { card: "p-card", field: "deployed", reading: "done", git: "not in the deploy and the tree" });
    // pack for a card a pair holds
    assert.deepEqual(one(withReading(clean(), "q-card", { wait: "pack" })), { card: "q-card", field: "pair", reading: "waits: pack", git: "packed" });
    // install for a card whose pair ran
    assert.deepEqual(one(withReading(clean(), "b-card", { state: "waiting", wait: "install", phase: "install" })), { card: "b-card", field: "pair", reading: "waits: install", git: "pair done" });
    // install for a card no pair holds
    assert.deepEqual(one(withReading(clean(), "p-card", { wait: "install" })), { card: "p-card", field: "pair", reading: "waits: install", git: "not packed" });
    // a FINDINGS note on the tip against a reading that is not rework
    assert.deepEqual(one(withReading(clean(), "f-card", { state: "waiting" })), { card: "f-card", field: "notes", reading: "waiting, not rework", git: "FINDINGS by checker" });
    // rework against a tip that has its sign-offs and no FINDINGS
    assert.deepEqual(one(withReading(clean(), "n-card", { state: "rework" })), { card: "n-card", field: "notes", reading: "rework", git: "no FINDINGS, signed: checker, security" });
    // land for a card main already holds
    assert.deepEqual(one(withReading(clean(), "b-card", { state: "waiting", wait: "land", phase: "ship" })), { card: "b-card", field: "onMain", reading: "waits: land", git: "on main" });
    // pack for a card that is not on main
    assert.deepEqual(one(withReading(clean(), "l-card", { wait: "pack" })), { card: "l-card", field: "onMain", reading: "waits: pack", git: "not on main" });
    // a product card that waits on a deploy while a version commit holds it
    assert.deepEqual(one(withReading(clean(), "c-card", { state: "waiting", wait: "deploy", phase: "ship" })), { card: "c-card", field: "deployed", reading: "waits: deploy", git: "in v1.0.2 on main" });
    // every string is 1..80
    for (const d of differences(fx, withReading(clean(), "f-card", { state: "waiting" }))) assert.ok(d.reading.length >= 1 && d.reading.length <= 80 && d.git.length >= 1 && d.git.length <= 80);
  } finally { fx.done(); }
});

test("a reading that says it cannot be trusted is skipped, and so is a young version commit", () => {
  const fx = build();
  try {
    const wrong = { state: "done", wait: null, phase: "live" };
    assert.equal(differences(fx, withReading(clean(), "l-card", { ...wrong, stale: true })).length, 0);
    assert.equal(differences(fx, withReading(clean(), "l-card", { ...wrong, state: "unknown" })).length, 0);
    assert.equal(differences(fx, withReading(clean(), "l-card", wrong)).length, 1);
    // a version commit under the settle window: a product card's deploy wait is not called wrong yet
    const young = ask(fx, "c-card", { deps: { now: Date.now() } });
    assert.equal(young.deployed, true);
    assert.deepEqual(compare(R("c-card", { wait: "deploy" }), young, { now: Date.now() }), []);
  } finally { fx.done(); }
});

test("a closed card whose reading is not done is compared on done only after an hour closed", () => {
  const fx = build(), f = facts(fx), at = LATER;
  try {
    const stuckAtShip = R("c-card", { wait: "deploy", closed: true, closedAt: at - 30 * 60_000 });
    assert.deepEqual(compare(stuckAtShip, f["c-card"], { now: at }), [], "closed half an hour ago: not yet");
    assert.deepEqual(compare({ ...stuckAtShip, closedAt: at - 2 * 3_600_000 }, f["c-card"], { now: at }), [{ field: "state", reading: "waiting, waits: deploy, card closed", git: "live: in v1.0.2 on main" }]);
    assert.deepEqual(compare({ ...stuckAtShip, closedAt: undefined }, f["c-card"], { now: at }), [], "a closed time we cannot read is not compared");
    assert.deepEqual(compare({ ...stuckAtShip, closedAt: at - 2 * 3_600_000 }, f["l-card"], { now: at }), [], "not live in git: nothing to say");
    assert.deepEqual(compare(R("c-card", { state: "done", closed: true, closedAt: at - 3 * 3_600_000 }), f["c-card"], { now: at }), [], "a closed card that reads done is compared as done");
  } finally { fx.done(); }
});

// ---- the two-run rule ----
function jobFiles() { const dir = mkdtempSync(join(tmpdir(), "fb-truth-state-")); return { dir, stateFile: join(dir, "truth-check.json"), done: () => rmSync(dir, { recursive: true, force: true }) }; }
async function run(files, readings, cardsFacts, now) { const writes = []; const value = await truthJob({ readings, cardsFacts, stateFile: files.stateFile, now, write: async (w) => writes.push(w) }); assert.equal(writes.length, 1); assert.equal(writes[0].key, "truth"); assert.deepEqual(writes[0].value, value); return value; }

test("two runs in a row: the first writes count 0, the second the item, a third keeps it", async () => {
  const fx = build(), files = jobFiles();
  try {
    const f = facts(fx), bad = withReading(clean(), "l-card", { state: "done", wait: null, phase: "live" });
    assert.equal(RUNS_TO_REPORT, 2);
    const v1 = await run(files, bad, f, 1000);
    assert.deepEqual(v1, { at: 1000, count: 0, items: [] });
    const v2 = await run(files, bad, f, 2000);
    assert.deepEqual(v2, { at: 2000, count: 1, items: [{ card: "l-card", num: 8, field: "onMain", reading: "done", git: "not on main" }] });
    assert.equal((await run(files, bad, f, 3000)).count, 1, "a third run keeps reporting");
    assert.deepEqual(JSON.parse(readFileSync(files.stateFile, "utf8")).seen["l-card|onMain"], { reading: "done", git: "not on main", n: 3 });
    assert.equal(readFileSync(files.stateFile).length > 0 && (execFileSync("stat", ["-f", "%Lp", files.stateFile], { encoding: "utf8" }).trim()), "600");
  } finally { fx.done(); files.done(); }
});

test("a changed value or an agreeing run starts the count again, and a clean run writes count 0 so the line clears", async () => {
  const fx = build(), files = jobFiles();
  try {
    const f = facts(fx), wrongDone = withReading(clean(), "l-card", { state: "done", wait: null, phase: "live" });
    await run(files, wrongDone, f, 1); await run(files, wrongDone, f, 2);
    // a changed reading value (the card now reads a wait, still wrong): the pair differs from last run's, so it is a first sighting
    const changed = withReading(clean(), "l-card", { wait: "pack" });
    assert.equal((await run(files, changed, f, 3)).count, 0);
    assert.equal((await run(files, changed, f, 4)).count, 1);
    // a changed git value: the card lands between the runs
    const f2 = { ...f, "l-card": { ...f["l-card"], onMain: true, deployed: true } };
    assert.equal((await run(files, changed, f2, 5)).count, 0, "the readings differ from git in another way: no wait pack difference, nothing kept");
    // an agreeing run drops it
    assert.deepEqual(await run(files, clean(), f, 6), { at: 6, count: 0, items: [] });
    // and a returning difference counts from one again
    assert.equal((await run(files, changed, f, 7)).count, 0);
    assert.equal((await run(files, changed, f, 8)).count, 1);
    // a card that was not asked this run loses its kept count
    await run(files, changed, {}, 9);
    assert.equal((await run(files, changed, f, 10)).count, 0);
  } finally { fx.done(); files.done(); }
});

test("at most 10 items are written, count is the whole number, and a damaged state file starts afresh", async () => {
  const files = jobFiles();
  try {
    const readings = Array.from({ length: 14 }, (_, i) => R(`x-${String(i).padStart(2, "0")}`, { num: 50 - i, state: "done", phase: "live" }));
    const cardsFacts = Object.fromEntries(readings.map((r) => [r.id, { kind: "board", onMain: false }]));
    writeFileSync(files.stateFile, "{not json");
    assert.equal((await run(files, readings, cardsFacts, 1)).count, 0);
    const v = await run(files, readings, cardsFacts, 2);
    assert.equal(v.count, 14);
    assert.equal(v.items.length, 10);
    assert.deepEqual(v.items.map((i) => i.num), [37, 38, 39, 40, 41, 42, 43, 44, 45, 46], "by number");
  } finally { files.done(); }
});

// ---- unread is never a difference ----
test("a git or folder read that fails gives unread and never a difference", () => {
  const fx = build();
  try {
    const broken = () => { const e = new Error("git says no"); e.status = 128; throw e; };
    const wrong = [R("l-card", { state: "done", phase: "live" }), R("p-card", { wait: "pack" }), R("q-card", { wait: "install" }), R("f-card", { state: "waiting", phase: "checker" }), R("c-card", { wait: "deploy" })];
    for (const [id] of Object.entries(HEADS(fx.s))) {
      const f = ask(fx, id, { deps: { git: broken } });
      assert.equal(f.onMain, UNREAD);
      for (const r of wrong) if (r.id === id) assert.deepEqual(compare(r, f, { now: LATER }), [], id);
    }
    // a commit this clone does not have, an unreadable pair folder, no worker sha, no notes refs: each is unread
    const gone = ask(fx, "p-card", { headSha: "a".repeat(40) });
    assert.equal(gone.onMain, UNREAD);
    const noFolder = ask(fx, "q-card", { deps: { pairs: readPairs(join(fx.dir, "no-such-folder")) } });
    assert.deepEqual([noFolder.onMain, noFolder.packed, noFolder.installed], [true, UNREAD, UNREAD]);
    assert.deepEqual(compare(R("q-card", { wait: "pack" }), noFolder, { now: LATER }), []);
    assert.deepEqual(compare(R("q-card", { wait: "install" }), noFolder, { now: LATER }), []);
    const noDeploy = ask(fx, "p-card", { deps: { workerSha: "", treeSha: "" } });
    assert.equal(noDeploy.deployed, UNREAD);
    assert.deepEqual(compare(R("p-card", { state: "done", phase: "live" }), noDeploy, { now: LATER }), []);
    const noNotes = ask(fx, "f-card", { notes: {} });
    assert.equal(noNotes.notes, UNREAD);
    assert.deepEqual(compare(R("f-card", { state: "waiting", phase: "checker" }), noNotes, { now: LATER }), []);
    assert.equal(ask(fx, "c-card", { versionPattern: null }).deployed, UNREAD);
    // one failed ref list makes the notes unread, not empty
    const noList = askGit({ id: "p-card", headSha: fx.s.P, kind: "board", dir: fx.dir, remote: "origin", main: "main", notes: NOTES }, { git: (d, a) => { if (a[0] === "notes") throw new Error("boom"); return defaultGit(d, a); }, pairs: null, now: LATER });
    assert.equal(noList.notes, UNREAD);
    assert.equal(noList.onMain, true);
    assert.equal(readPairs("", {}), null);
    assert.deepEqual(readPairs(fx.pairFolder).map((p) => [p.n, p.ran]), [[6, false], [5, true]]);
    // a .done that holds another sha is no install
    writeFileSync(join(fx.pairFolder, "board-store-deploy-pc6.done"), `${fx.s.P}\n`);
    assert.equal(readPairs(fx.pairFolder)[0].ran, false);
  } finally { fx.done(); }
});

test("the rules still hold when the commit has only a trailer-matched twin on main: a different subject is not it", () => {
  const fx = build();
  try {
    fx.git("checkout", "-q", "-b", "admin/other", fx.s.P);
    writeFileSync(join(fx.dir, "o.txt"), "o\n"); fx.git("add", "-A"); fx.git("commit", "-q", "-m", "A different subject\n\nBoard-Id: s-card");
    const other = fx.git("rev-parse", "HEAD");
    fx.git("checkout", "-q", "main");
    const f = askGit({ id: "s-card", headSha: other, kind: "board", dir: fx.dir, remote: "origin", main: "main", notes: NOTES }, { git: defaultGit, pairs: null, now: LATER });
    assert.equal(f.onMain, false);
  } finally { fx.done(); }
});

test("a version main shipped before the merge does not hold the card, and the first one after it does", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-truth-between-")), git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    const commit = (name, msg) => { writeFileSync(join(dir, name), `${name}\n`); git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
    commit("a.txt", "base");
    git("checkout", "-q", "-b", "admin/c", "main");
    const card = commit("c.txt", "card\n\nBoard-Id: c-card");
    git("checkout", "-q", "main");
    commit("e.txt", "v1.0.2: admin/another@abc");
    git("merge", "-q", "--no-ff", "-m", "Merge", card);
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const ask1 = () => askGit({ id: "c-card", headSha: card, kind: "product", dir, remote: "origin", main: "main", notes: {}, versionPattern: PATTERN }, { git: defaultGit, pairs: null, now: LATER });
    assert.deepEqual([ask1().onMain, ask1().deployed], [true, false], "1.0.2 was shipped before the card was merged: it does not hold it");
    commit("f.txt", "v1.0.3: admin/c@abc");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    assert.deepEqual([ask1().deployed, ask1().version], [true, "1.0.3"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- #C1387 F2: the rules the facts rest on ----
test("an ancestry answer git cannot give is unread, never a no: not on main, and not in the deploy", () => {
  const fx = build();
  try {
    // merge-base fails with status 128 (a commit this clone lacks) while every other read works: the answer is unread, and landedAs is not asked to say "not on main"
    const noMergeBase = (d, a) => { if (a[0] === "merge-base") { const e = new Error("bad object"); e.status = 128; throw e; } return defaultGit(d, a); };
    const f = ask(fx, "l-card", { deps: { git: noMergeBase } });
    assert.equal(f.onMain, UNREAD);
    assert.deepEqual(compare(R("l-card", { wait: "pack" }), f, { now: LATER }), []);
    // only the question about the Worker's commit fails: the pair is mixed, so the deploy is unread, never false
    const treeSha = fx.s.Q, workerSha = fx.s.P;
    const failOnWorker = (d, a) => { if (a[0] === "merge-base" && a[3] === workerSha) { const e = new Error("bad object"); e.status = 128; throw e; } return defaultGit(d, a); };
    const g = ask(fx, "b-card", { deps: { git: failOnWorker, workerSha, treeSha } });
    assert.equal(g.onMain, true);
    assert.equal(g.deployed, UNREAD);
    assert.deepEqual(compare(R("b-card", { state: "done", phase: "live" }), g, { now: LATER }), []);
    // a false from the other side still decides: the tree lacks it
    const failOnTree = (d, a) => { if (a[0] === "merge-base" && a[3] === fx.s.base) { const e = new Error("bad object"); e.status = 128; throw e; } return defaultGit(d, a); };
    assert.equal(ask(fx, "p-card", { deps: { git: failOnTree, workerSha: fx.s.Q, treeSha: fx.s.base } }).deployed, false, "the Worker lacks it, so no after one unread");
  } finally { fx.done(); }
});

test("a board card is deployed only when the Worker's commit AND the Studio tree hold it", () => {
  const fx = build();
  try {
    const deployed = (workerSha, treeSha) => ask(fx, "b-card", { deps: { workerSha, treeSha } }).deployed;
    assert.equal(deployed(fx.s.Q, fx.s.Q), true);
    assert.equal(deployed(fx.s.Q, fx.s.base), false, "the Worker has it, the tree has not");
    assert.equal(deployed(fx.s.base, fx.s.Q), false, "the tree has it, the Worker has not");
    assert.equal(deployed(fx.s.base, fx.s.base), false);
  } finally { fx.done(); }
});

test("a landing of code and docs is not docs only: it needs its deploy and its pack", () => {
  const fx = build();
  try {
    writeFileSync(join(fx.dir, "docs", "y.md"), "y\n"); writeFileSync(join(fx.dir, "collector", "z.mjs"), "z\n");
    fx.git("add", "-A"); fx.git("commit", "-q", "-m", "Code and docs\n\nBoard-Id: mixed-card");
    const mixed = fx.git("rev-parse", "HEAD");
    fx.git("update-ref", "refs/remotes/origin/main", mixed);
    const f = askGit({ id: "mixed-card", headSha: mixed, kind: "board", dir: fx.dir, remote: "origin", main: "main", notes: NOTES }, { git: defaultGit, pairs: [], workerSha: fx.s.base, treeSha: fx.s.base, now: LATER });
    assert.equal(f.onMain, true);
    assert.equal(f.docsOnly, false);
    assert.equal(f.deployed, false);
    assert.equal(f.packed, false);
    assert.ok(compare(R("mixed-card", { state: "done", phase: "live" }), f, { now: LATER }).some((d) => d.field === "deployed"));
  } finally { fx.done(); }
});

// ---- #C1387 F1: the close time the Worker really serves ----
test("a closed card as the Worker serves it (closed: true, closedAt) is compared, and one inside the grace is not", async () => {
  const { readingDocs } = await import("../worker/compat-reading.mjs");
  const view = JSON.parse(readFileSync(new URL("./fixtures/view-recorded.json", import.meta.url), "utf8"));
  const docs = readingDocs(view).filter((d) => d.closed && d.state !== "done");
  assert.ok(docs.length > 0, "the recorded view holds closed cards that do not read done");
  for (const d of docs) assert.ok(d.closedAt === view.cards.find((c) => c.id === d.id).done_at && Number.isFinite(d.closedAt), d.id);
  const d = docs[0], live = { kind: "board", onMain: true, deployed: true, docsOnly: false };
  const got = compare(d, live, { now: d.closedAt + 2 * 3_600_000 });
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].field, "state");
  assert.deepEqual(compare(d, live, { now: d.closedAt + 30 * 60_000 }), []);
  assert.ok(pickReadings(docs, docs[0].closedAt + 86_400_000).length > 0, "a card closed a day ago is picked");
  assert.deepEqual(pickReadings(docs, docs[0].closedAt + 8 * 86_400_000).filter((x) => x.id === d.id), [], "closed 8 days ago: not picked");
});

// ---- the file stands alone ----
test("the job file imports nothing that feeds the evidence", () => {
  const src = readFileSync(new URL("../collector/truth-check.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 3);
  for (const m of imports) assert.match(m, /^node:[a-z_:]+$/, `only node's own modules: ${m}`);
  for (const bad of ["worker/reading.mjs", "worker/compat-reading.mjs", "collector/state.mjs", "reading.mjs", "state.mjs", "pairs.mjs", "signoff.mjs"]) assert.ok(!imports.some((m) => m.includes(bad)), bad);
  assert.ok(!/import\(/.test(src) && !/require\(/.test(src), "no dynamic import either");
});

// ---- the step ----
const config = (fx) => JSON.stringify({ collector: { repoPath: fx.dir, remote: "origin", mainBranch: "main", notes: NOTES, versionPattern: PATTERN, pairFolder: fx.pairFolder, repos: [{ name: "flight-board", path: fx.dir, kind: "board" }] } });
function stepEnv(fx, files, { readings, status = 200, fail = false } = {}) {
  const posts = [], logs = [];
  const fetchImpl = async (url, o = {}) => {
    if (fail) throw new Error("network down");
    if (url.endsWith("/api/probe/readings")) return { ok: status === 200, status, json: async () => ({ readings, now: LATER }) };
    if (url.endsWith("/api/probe/evidence")) { posts.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({}) }; }
    throw new Error(`unexpected ${url}`);
  };
  const cards = Object.fromEntries(Object.entries(HEADS(fx.s)).map(([id, headSha]) => [id, { headSha }]));
  cards["no-head"] = { headSha12: "abc" };
  return { posts, logs, args: { base: "https://board.example.test", headers: {}, fetchImpl, origConfig: "/board.config.json", stateFile: join(files.dir, "state.json"), state: { cards }, read: (p) => (p === "/board.config.json" ? config(fx) : readFileSync(p, "utf8")), log: (l) => logs.push(l), now: LATER, deploy: async () => ({ worker: fx.s.Q, tree: fx.s.Q }) } };
}

test("the step reads the readings, asks git, writes the key truth every run, and reports on the second", async () => {
  const fx = build(), files = jobFiles();
  try {
    const readings = [...withReading(clean(), "l-card", { state: "done", wait: null, phase: "live" }), R("no-head", { num: 99, state: "done" }), R("gone", { num: 98, state: "done" })];
    const env = stepEnv(fx, files, { readings });
    const v1 = await truthStep(env.args);
    assert.equal(v1.count, 0);
    const v2 = await truthStep(env.args);
    assert.deepEqual(v2.items, [{ card: "l-card", num: 8, field: "onMain", reading: "done", git: "not on main" }]);
    assert.deepEqual(env.posts.map((p) => [p.key, p.value.count]), [["truth", 0], ["truth", 1]]);
    assert.ok(env.logs.some((l) => /card\(s\) skipped/.test(l)), env.logs.join("\n"));
  } finally { fx.done(); files.done(); }
});

test("the step never throws and writes nothing when the readings cannot be fetched", async () => {
  const fx = build(), files = jobFiles();
  try {
    for (const opt of [{ fail: true }, { status: 500 }, { status: 200, readings: "not a list" }]) {
      const env = stepEnv(fx, files, { readings: [], ...opt });
      assert.equal(await truthStep(env.args), null);
      assert.deepEqual(env.posts, []);
      assert.equal(existsSync(join(files.dir, "truth-check.json")), false);
      assert.equal(env.logs.filter((l) => l.startsWith("truth")).length, 1, env.logs.join("\n"));
    }
    // a config that cannot be read, a deploy read that throws, a post that fails
    const env = stepEnv(fx, files, { readings: clean() });
    assert.equal(await truthStep({ ...env.args, read: () => { throw new Error("no"); } }), null);
    assert.equal(await truthStep({ ...env.args, deploy: async () => { throw new Error("no"); } }), null);
    assert.equal(await truthStep({ ...env.args, post: async () => { throw new Error("evidence write truth answered 500"); } }), null);
    assert.equal(await truthStep({ ...env.args, state: {} }), null);
    assert.deepEqual(env.posts, []);
    assert.equal(existsSync(join(files.dir, "truth-check.json")), false, "a failed write does not advance the count");
  } finally { fx.done(); files.done(); }
});

test("the usage job calls the step and a failing step does not fail the job", async () => {
  assert.equal(typeof truthStepFromEvidence, "function");
  const src = readFileSync(new URL("../collector/probe-evidence.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(job === "usage"\) await truthStep\(\{/);
  assert.ok(src.indexOf("await truthStep({") < src.indexOf("await actionsUsageStep({"), "before the Actions step, which has its own deadline");
});

test("at most CARD_CAP cards are asked, the first by number, closed cards only inside the window", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `c-${i}`, num: 80 - i }));
  const picked = pickReadings(many, 1e12);
  assert.equal(picked.length, CARD_CAP);
  assert.equal(CARD_CAP, 60);
  assert.deepEqual([picked[0].num, picked[59].num], [1, 60]);
  const old = [{ id: "a", num: 1, closed: true, closedAt: 1e12 - 8 * 86_400_000 }, { id: "b", num: 2, closed: true, closedAt: 1e12 - 86_400_000 }, { id: "c", num: 3 }, { id: "d", num: 4, closed: true }];
  assert.deepEqual(pickReadings(old, 1e12).map((r) => r.id), ["b", "c", "d"]);
  // the out-of-time cut leaves the rest for the next run
  const logs = [];
  const f = gatherFacts({ readings: [{ id: "a-1", num: 1 }], cards: { "a-1": { headSha: "b".repeat(40) } }, config: { repoPath: "/x" }, deploy: {}, git: () => { throw new Error("none"); }, deadline: 0, clock: () => 1, log: (l) => logs.push(l) });
  assert.deepEqual(f, {});
  assert.ok(logs.some((l) => /out of time/.test(l)));
});

// ---- the mutation test: the check catches the false reading the real chain makes ----
// The chain: collector/state.mjs cardState (evidence) -> worker/reading.mjs reading() -> compare against git's own answers. #C1376 fixed versionAfter to drop --first-parent from the ancestry
// path; a COPY of the code with it put back reads the behind-a-merge card at ship, and the truth check must say so. The checkout is never touched.
function copyWithFirstParent() {
  const dir = mkdtempSync(join(tmpdir(), "fb-truth-mutant-"));
  for (const d of ["collector", "worker", "gate", "scripts"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true, filter: (p) => !/node_modules|\.wrangler/.test(p) });
  if (existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const file = join(dir, "collector", "state.mjs"), text = readFileSync(file, "utf8");
  const from = 'git(["rev-list", "--ancestry-path", `${sha}..${ref}`])', to = 'git(["rev-list", "--first-parent", "--ancestry-path", `${sha}..${ref}`])';
  assert.ok(text.includes(from), "versionAfter's ancestry path is where the test expects it");
  assert.equal(text.split(from).length, 2);
  writeFileSync(file, text.replace(from, to));
  return dir;
}
function chainReading(fx, state, readingFn) {
  const git = fx.git, cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: NOTES, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
  const T = Date.now();
  const tips = [{ branch: "admin/c-card", sha: fx.s.card, at: T, message: "The card's work\n\nBoard-Id: c-card" }, { branch: "main", sha: fx.s.S2, at: T - 1000, message: "main" }];
  const evidence = state({ id: "c-card", num: 1315, level: "Quick", phase: "ship" }, { git: (args) => git(...args), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips, live: fx.s.V, versionPattern: PATTERN, shippedPattern: "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})" }, cfg, T);
  const card = { id: "c-card", num: 1315, repo: "shop", owner_role: "Builder", status: "active" };
  return { evidence, reading: readingFn(card, { lit: [evidence.phase], ...evidence }, [], {}, { repos: [{ name: "shop", kind: "product" }], owner: "owner" }, T) };
}

test("mutation: with --first-parent put back into versionAfter the truth check reports the behind-a-merge card; on the clean source it reports nothing", async () => {
  const fx = build(), copy = copyWithFirstParent();
  try {
    const f = ask(fx, "c-card");
    assert.deepEqual([f.onMain, f.deployed, f.version], [true, true, "1.0.2"]);
    // clean source: the card reads live and git agrees
    const good = chainReading(fx, cardState, readingOf);
    assert.equal(good.evidence.phase, "live");
    assert.equal(good.reading.state, "done");
    assert.deepEqual(compare({ ...good.reading, id: "c-card" }, f, { now: LATER }), []);
    // the mutated copy: the same chain reads the card at ship and waiting on a deploy
    const mutated = await import(pathToFileURL(join(copy, "collector", "state.mjs")).href);
    const mutatedReading = await import(pathToFileURL(join(copy, "worker", "reading.mjs")).href);
    const bad = chainReading(fx, mutated.cardState, mutatedReading.reading);
    assert.equal(bad.evidence.phase, "ship", "the mutant is a real one: the chain's reading is wrong");
    assert.deepEqual([bad.reading.state, bad.reading.wait], ["waiting", "deploy"]);
    const found = compare({ ...bad.reading, id: "c-card" }, f, { now: LATER });
    assert.deepEqual(found, [{ field: "deployed", reading: "waits: deploy", git: "in v1.0.2 on main" }]);
    // and over two runs the job reports it, naming the card with both values
    const files = jobFiles();
    try {
      const rs = [{ ...bad.reading, id: "c-card", num: 1315 }];
      await run(files, rs, { "c-card": f }, 1);
      const v = await run(files, rs, { "c-card": f }, 2);
      assert.deepEqual(v.items, [{ card: "c-card", num: 1315, field: "deployed", reading: "waits: deploy", git: "in v1.0.2 on main" }]);
    } finally { files.done(); }
  } finally { fx.done(); rmSync(copy, { recursive: true, force: true }); }
});
