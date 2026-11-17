// #C1146 (split out of #C1068): the group check before a group head lands. Each card is reviewed alone, but not how the cards meet. A head that carries two or more cards
// lands only with Checker's READ note on that exact commit, naming every file two or more of its cards touch, and after one run of the full suite on the head.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUP_NOTE_REF, groupFacts, groupLogArgs, groupVerdict, parseGroupLog, readMissing, readNote, sharedFiles, suiteOnSnapshot } from "../scripts/group-check.mjs";
import { landPlan, landRun } from "../scripts/board-land.mjs";
import { JOBS, LAND_MARGIN_SEC, LAND_SUITE_SEC, LAND_TIP_SEC } from "../worker/probe-jobs.mjs";

const NOW = 1_800_000_000_000;
const sha = (n) => String(n).padStart(40, "0");
const ok = { checker: "PASS Full at abc", security: "SECURE at abc" };
const free = (...ids) => ({ at: NOW, cards: Object.fromEntries(ids.map((c) => [c, ""])) });
const GREEN = { ok: true, line: "green" };
const head = (n, over = {}) => ({ branch: `build/g-${n}`, sha: sha(n), notes: ok, cards: ["card-1", "card-2"], onMain: false, forward: true, ahead: 5, dataLines: 0, group: { shared: [], read: null, suite: GREEN }, ...over });
const SEP = "\u0001";
const logText = (commits) => commits.map((c) => `${SEP}${c.sha}${SEP}${c.cards.join(",")}\n\n${c.files.join("\n")}\n`).join("");

test("parseGroupLog reads the commits, their Board-Ids and files; a merge lists none (the args ask for no merges); a text not in the shape is null, never an empty list", () => {
  assert.ok(groupLogArgs("origin/main", "abc").includes("--no-merges"));
  assert.ok(groupLogArgs("origin/main", "abc").includes("--name-only"));
  assert.equal(groupLogArgs("origin/main", "abc").at(-1), "origin/main..abc");
  const got = parseGroupLog(logText([{ sha: sha(1), cards: ["card-1"], files: ["a.mjs", "b.mjs"] }, { sha: sha(2), cards: ["card-1", "card-2"], files: ["b.mjs"] }, { sha: sha(3), cards: [], files: ["c.mjs"] }]));
  assert.deepEqual(got, [{ sha: sha(1), cards: ["card-1"], files: ["a.mjs", "b.mjs"] }, { sha: sha(2), cards: ["card-1", "card-2"], files: ["b.mjs"] }, { sha: sha(3), cards: [], files: ["c.mjs"] }]);
  assert.deepEqual(parseGroupLog(""), [], "no commit in the range");
  assert.equal(parseGroupLog(null), null);
  assert.equal(parseGroupLog(`${SEP}not-a-sha${SEP}x\n`), null);
});

test("sharedFiles: a file two or more DIFFERENT cards touch; one card twice, a commit with no card, and a failed read are not shared", () => {
  const c = (cards, ...files) => ({ cards, files });
  assert.deepEqual(sharedFiles([c(["card-1"], "a.mjs", "b.mjs"), c(["card-2"], "b.mjs", "c.mjs")]), ["b.mjs"]);
  assert.deepEqual(sharedFiles([c(["card-1"], "a.mjs"), c(["card-1"], "a.mjs")]), [], "the same card twice is one card");
  assert.deepEqual(sharedFiles([c(["card-1"], "a.mjs"), c([], "a.mjs")]), [], "a commit with no Board-Id adds no card");
  assert.deepEqual(sharedFiles([c(["card-1", "card-2"], "a.mjs")]), ["a.mjs"], "one commit that carries two Board-Ids counts both");
  assert.deepEqual(sharedFiles([c(["card-1"], "z.mjs"), c(["card-2"], "z.mjs"), c(["card-1"], "a.mjs"), c(["card-3"], "a.mjs")]), ["a.mjs", "z.mjs"], "sorted");
  assert.deepEqual(sharedFiles([]), []);
  assert.equal(sharedFiles(null), null, "a failed read is null, never an empty list");
});

test("the READ note covers the shared files when its first line is READ and it names every one; a stale or foreign note covers none", () => {
  const shared = ["a.mjs", "b.mjs"];
  const note = readNote("Checker 2", shared);
  assert.match(note.split("\n")[0], /^READ 2 files two or more cards touch, signed by Checker 2$/);
  assert.deepEqual(readMissing(note, shared), []);
  assert.deepEqual(readMissing(note, [...shared, "c.mjs"]), ["c.mjs"], "a file that became shared after the note is missing");
  assert.deepEqual(readMissing(note.replace(/^READ/, "PASS"), shared), shared, "the first line must be READ");
  assert.deepEqual(readMissing("READING a.mjs\nb.mjs", shared), shared, "the word READ, not a longer one");
  assert.deepEqual(readMissing(null, shared), shared);
  assert.deepEqual(readMissing("", []), [], "nothing shared: nothing to name");
  assert.match(readNote("X", ["only.mjs"]), /^READ 1 file two/);
});

test("groupVerdict: none for fewer than two cards; wait for a failed read or a missing READ; run, fail and ok by the suite record", () => {
  const base = { cards: ["card-1", "card-2"], shared: [], read: null };
  assert.equal(groupVerdict({ cards: ["card-1"], shared: null }).state, "none");
  assert.equal(groupVerdict({ cards: [] }).state, "none");
  assert.equal(groupVerdict(undefined).state, "none");
  assert.match(groupVerdict({ ...base, shared: null }).why, /could not be read/);
  const w = groupVerdict({ ...base, shared: ["a.mjs", "b.mjs"], read: null });
  assert.equal(w.state, "wait");
  assert.match(w.why, /Checker has not read the 2 files two or more of its cards touch \(a\.mjs, b\.mjs\)/);
  assert.match(groupVerdict({ ...base, shared: Array.from({ length: 7 }, (_, i) => `f${i}.mjs`) }).why, /f0\.mjs, f1\.mjs, f2\.mjs, f3\.mjs, and 3 more/);
  assert.equal(groupVerdict({ ...base, shared: ["a.mjs"], read: readNote("C", ["a.mjs"]) }).state, "run", "read in place, no suite yet");
  assert.equal(groupVerdict({ ...base, shared: [] }).state, "run", "nothing shared: no READ is wanted, the suite still runs");
  assert.equal(groupVerdict({ ...base, suite: { ok: false, line: "exit 1, not ok 3 - x" } }).state, "fail");
  assert.match(groupVerdict({ ...base, suite: { ok: false, line: "exit 1" } }).why, /^the full suite on the group head was red: exit 1/);
  assert.equal(groupVerdict({ ...base, suite: { ok: "true" } }).state, "fail", "only a real true passes");
  assert.equal(groupVerdict({ ...base, suite: GREEN }).state, "ok");
});

test("the plan: a head of two or more cards waits without Checker's READ, is tried with needSuite once it has it, is blocked by a red suite and tried plainly after a green one", () => {
  const holds = free("card-1", "card-2");
  const plan = (g) => landPlan({ heads: [head(1, { group: g })], holds, now: NOW });
  const unread = plan({ shared: ["x.mjs"], read: null });
  assert.deepEqual(unread.try, []);
  assert.match(unread.waiting[0].why, /^group check: Checker has not read the 1 file two or more of its cards touch \(x\.mjs\)/);
  const none = landPlan({ heads: [head(1, { group: undefined })], holds, now: NOW });
  assert.deepEqual(none.try, [], "facts that were not read are a wait, never a pass");
  assert.match(none.waiting[0].why, /could not be read/);
  const read = plan({ shared: ["x.mjs"], read: readNote("Checker 2", ["x.mjs"]) });
  assert.equal(read.try.length, 1);
  assert.equal(read.try[0].needSuite, true);
  const red = plan({ shared: [], read: null, suite: { ok: false, line: "exit 1, not ok 4 - the thing" } });
  assert.deepEqual(red.try, []);
  assert.equal(red.blocked.length, 1);
  assert.match(red.blocked[0].reasons[0], /^the full suite on the group head was red: exit 1, not ok 4 - the thing/);
  const green = plan({ shared: [], read: null, suite: GREEN });
  assert.equal(green.try.length, 1);
  assert.equal(green.try[0].needSuite, undefined);
});

test("groupFacts: read only for a head of two or more cards, from the log, the READ note and the kept verdict; a failed read is null, never empty", () => {
  const seen = [];
  const quiet = (a) => { seen.push(a); return a[0] === "log" ? logText([{ sha: sha(1), cards: ["card-1"], files: ["x.mjs"] }, { sha: sha(2), cards: ["card-2"], files: ["x.mjs"] }]) : "READ 1 file\nx.mjs"; };
  const suites = { [sha(9)]: GREEN };
  const g = groupFacts({ cards: ["card-1", "card-2"], quiet, main: "MAIN", sha: sha(9), suites });
  assert.deepEqual(g, { shared: ["x.mjs"], read: "READ 1 file\nx.mjs", suite: GREEN });
  assert.deepEqual(seen[0].at(-1), `MAIN..${sha(9)}`);
  assert.deepEqual(seen[1], ["notes", "--ref=board-release/group", "show", sha(9)], "the note read is the fetched copy of the group ref, on this sha");
  assert.equal(groupFacts({ cards: ["card-1", "card-2"], quiet, main: "M", sha: sha(8), suites }).suite, undefined, "another sha has no verdict");
  assert.equal(groupFacts({ cards: ["card-1", "card-2"], quiet, main: "M", sha: sha(8) }).suite, undefined, "no verdicts kept at all");
  assert.equal(groupFacts({ cards: ["card-1"], quiet, main: "M", sha: sha(9), suites }), undefined);
  assert.equal(groupFacts({ cards: undefined, quiet, main: "M", sha: sha(9), suites }), undefined);
  const failed = groupFacts({ cards: ["a-1", "b-2"], quiet: () => null, main: "M", sha: sha(9), suites: {} });
  assert.deepEqual(failed, { shared: null, read: null, suite: undefined });
  assert.equal(groupVerdict({ cards: ["a-1", "b-2"], ...failed }).state, "wait");
});

test("a head of one card asks nothing of the group check, whatever its facts say", () => {
  const solo = landPlan({ heads: [head(1, { cards: ["card-1"], group: undefined })], holds: free("card-1"), now: NOW });
  assert.equal(solo.try.length, 1);
  assert.equal(solo.try[0].needSuite, undefined);
});

test("the run: the suite runs once on the head before the release tool, a red one is a refusal with no release call, a green one lands it, and the verdict is recorded", () => {
  const calls = [], rec = [];
  const mk = (suite) => landRun({
    readFacts: () => ({ heads: [head(1, { group: { shared: [], read: null, suite: undefined } })] }), readHolds: () => free("card-1", "card-2"), now: NOW, dry: false,
    release: (s, dryRun) => { calls.push(`release ${dryRun ? "dry" : "real"}`); return { code: 0, text: "" }; },
    runSuite: (s) => { calls.push(`suite ${s.slice(-1)}`); return suite; }, recordSuite: (s, r) => rec.push([s, r]), suiteMs: 1000,
  });
  const red = mk({ ok: false, line: "exit 1, not ok 9 - merge" });
  assert.deepEqual(calls, ["suite 1"], "no release call after a red suite");
  assert.equal(red.landed.length, 0);
  assert.match(red.refused[0].reasons[0], /^the full suite on the group head was red: exit 1, not ok 9 - merge/);
  assert.equal(rec.length, 1);
  assert.equal(rec[0][1].ok, false);
  calls.length = 0; rec.length = 0;
  const green = mk(GREEN);
  assert.deepEqual(calls, ["suite 1", "release dry", "release real"], "the suite once, then the dry run and the real run");
  assert.equal(green.landed.length, 1);
  assert.deepEqual(rec.map(([s, r]) => [s, r.ok]), [[sha(1), true]]);
});

test("the run: a suite that throws, or gives no verdict, is red; with no way to run it the head waits; a tip starts only while the suite's time fits too", () => {
  const base = { readFacts: () => ({ heads: [head(1, { group: { shared: [], read: null, suite: undefined } })] }), readHolds: () => free("card-1", "card-2"), now: NOW, release: () => ({ code: 0, text: "" }) };
  const thrown = landRun({ ...base, runSuite: () => { throw new Error("spawn failed\nmore"); } });
  assert.match(thrown.refused[0].reasons[0], /the suite run failed to start: spawn failed$/);
  assert.match(landRun({ ...base, runSuite: () => null }).refused[0].reasons[0], /gave no verdict/);
  assert.match(landRun({ ...base, runSuite: () => ({ ok: "yes" }) }).refused[0].reasons[0], /gave no verdict/);
  const none = landRun(base);
  assert.equal(none.landed.length + none.refused.length, 0);
  assert.match(none.waiting[0].why, /no way to run the suite/);
  let now = 0;
  const tight = landRun({ ...base, clock: () => now, budgetMs: 1500, tipMs: 1000, suiteMs: 1000, runSuite: () => GREEN });
  assert.equal(tight.landed.length, 0, "1000 + 1000 does not fit in 1500");
  assert.match(tight.waiting[0].why, /no time left in this run/);
  const fits = landRun({ ...base, clock: () => now, budgetMs: 2500, tipMs: 1000, suiteMs: 1000, runSuite: () => GREEN });
  assert.equal(fits.landed.length, 1);
});

test("the run: a head whose suite is already green does not run it again, and a recordSuite that throws does not stop the landing", () => {
  let ran = 0;
  const r = landRun({ readFacts: () => ({ heads: [head(1)] }), readHolds: () => free("card-1", "card-2"), now: NOW, release: () => ({ code: 0, text: "" }), runSuite: () => { ran++; return GREEN; } });
  assert.equal(ran, 0);
  assert.equal(r.landed.length, 1);
  const t = landRun({ readFacts: () => ({ heads: [head(1, { group: { shared: [], read: null, suite: undefined } })] }), readHolds: () => free("card-1", "card-2"), now: NOW, release: () => ({ code: 0, text: "" }), runSuite: () => GREEN, recordSuite: () => { throw new Error("disk full"); } });
  assert.equal(t.landed.length, 1);
});

test("suiteOnSnapshot: a detached worktree of the sha, the suite there, and the folder removed after a green, a red and a failed snapshot", () => {
  const log = [];
  const deps = (over = {}) => ({ sha: sha(7), mkdtemp: () => "/tmp/snap", run: (a) => { log.push(["git", ...a]); }, suite: (d) => { log.push(["suite", d]); return GREEN; }, remove: (d) => { log.push(["remove", d]); }, ...over });
  assert.deepEqual(suiteOnSnapshot(deps()), GREEN);
  assert.deepEqual(log, [["git", "worktree", "add", "--detach", "/tmp/snap", sha(7)], ["suite", "/tmp/snap"], ["remove", "/tmp/snap"]]);
  log.length = 0;
  assert.equal(suiteOnSnapshot(deps({ suite: () => ({ ok: false, line: "exit 1" }) })).ok, false);
  assert.deepEqual(log.at(-1), ["remove", "/tmp/snap"], "removed after a red suite");
  log.length = 0;
  const bad = suiteOnSnapshot(deps({ run: () => { throw new Error("fatal: no such commit\nx"); } }));
  assert.deepEqual(bad, { ok: false, line: "the snapshot could not be made or run: fatal: no such commit" });
  assert.deepEqual(log, [["remove", "/tmp/snap"]], "removed after a failed snapshot");
  assert.equal(suiteOnSnapshot(deps({ remove: () => { throw new Error("busy"); } })).ok, true, "a folder that will not go does not change the verdict");
});

test("the land cadence fits a head's suite run and a whole landing before the alarm", () => {
  assert.ok(LAND_SUITE_SEC + LAND_TIP_SEC <= JOBS.land.limitSec - LAND_MARGIN_SEC, "a head tip can still start in a fresh run");
});

test("the real job wires the check: the suite runner is not given to a dry run, and the READ note ref is fetched", () => {
  const src = readFileSync(fileURLToPath(new URL("../scripts/board-land.mjs", import.meta.url)), "utf8");
  assert.match(src, /runSuite: dry \? null : runSuite/);
  assert.ok(src.includes("+${GROUP_NOTE_REF}:refs/notes/board-release/group"));
  assert.equal(GROUP_NOTE_REF, "refs/notes/group-check");
});

// The command line, against a real repository: files lists the shared files, read writes the note on the head.
test("group-check.mjs files and read, in a real repository", () => {
  const root = mkdtempSync(join(tmpdir(), "group-check-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  const cli = fileURLToPath(new URL("../scripts/group-check.mjs", import.meta.url));
  try {
    run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    run(root, "clone", "-q", "origin.git", "w");
    const w = join(root, "w");
    writeFileSync(join(w, "base.txt"), "base\n"); run(w, "add", "."); run(w, "commit", "-q", "-m", "base"); run(w, "push", "-q", "origin", "HEAD:refs/heads/main"); run(w, "fetch", "-q", "origin");
    const card = (id, file, text) => { mkdirSync(join(w, "src"), { recursive: true }); writeFileSync(join(w, file), text); run(w, "add", "."); run(w, "commit", "-q", "-m", `work on ${id}\n\nBoard-Id: ${id}\nCo-Authored-By: T <t@t>`); };
    card("card-1", "src/a.txt", "1\n"); card("card-1", "src/shared.txt", "1\n"); card("card-2", "src/shared.txt", "2\n"); card("card-2", "src/b.txt", "2\n");
    const tip = run(w, "rev-parse", "HEAD");
    const files = execFileSync(process.execPath, [cli, "files", "--sha", tip], { cwd: w, encoding: "utf8" }).trim();
    assert.equal(files, "src/shared.txt");
    const out = execFileSync(process.execPath, [cli, "read", "--sha", tip, "--signer", "Checker 2", "--push"], { cwd: w, encoding: "utf8" });
    assert.match(out, /^READ [0-9a-f]{12}: 1 shared file\(s\), pushed/);
    const note = run(root, "--git-dir=origin.git", "notes", `--ref=${GROUP_NOTE_REF}`, "show", tip);
    assert.deepEqual(readMissing(note, ["src/shared.txt"]), []);
    assert.match(note, /signed by Checker 2/);
    // refusals: a short sha, a bad signer
    assert.throws(() => execFileSync(process.execPath, [cli, "read", "--sha", tip.slice(0, 8), "--signer", "C"], { cwd: w, stdio: "pipe" }));
    assert.throws(() => execFileSync(process.execPath, [cli, "read", "--sha", tip, "--signer", "x;rm"], { cwd: w, stdio: "pipe" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
