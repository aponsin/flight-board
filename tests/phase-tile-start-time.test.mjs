// #C881 (the owner, 2026-11-10 9:37 pm: "I don't see any time captured anywhere anymore when a phase started"; PARITY row 78 had said "same"):
// each phase tile shows when its phase first began and the role that began it, in Mountain time, from the phase history the Worker holds.
// The data: the build row exists from the first push (Started = first push, row 35), the "who" of a row is the phase's lane, not whoever else
// works the card, and a flip between phases never restarts a phase's time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, readView } from "../worker/board-store.mjs";
import { compatView, timesOfHistory } from "../worker/compat-view.mjs";
import { whoForPhase, PHASE_LANES } from "../worker/board-rules.mjs";
import { cardState } from "../collector/state.mjs";
import { render } from "../scripts/fixtures.mjs";

// 2026-11-11 04:15 UTC is 9:15 pm on Nov 10 in Mountain time (standard time since Nov 1).
const T = Date.UTC(2026, 10, 11, 4, 15), MIN = 60_000;
const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const lit = (p) => ({ lit: [p], phase: p });
const hist = async (db) => (await db.prepare("SELECT phase, kind, at, who FROM phase_history ORDER BY id").all()).results;
const seed = async () => { const db = makeDb(); await createCard(db, T - 5 * MIN, "Manager", { id: "c1", title: "A card", owner_role: "Builder" }); return db; };
const board = async (db) => render(page, compatView(await readView(db, Date.now())).collections).board;
// The text of a phase's tile (everything between its opening div and the next tile's).
const tile = (html, label) => { const m = html.match(new RegExp(`<div class="step[^"]*" title="${label}[^"]*">[\\s\\S]*?</div>`)); return m && m[0]; };

test("a card first read at checker gets a build row at that first push, and each lit tile shows its start time and role in MT", async () => {
  const db = await seed();
  await writeEvidence(db, T - MIN, "probe", "agents", { Builder: { state: "working", card: "c1" } });
  await writeEvidence(db, T, "probe", "cards.c1", lit("checker"));
  assert.deepEqual(await hist(db), [
    { phase: "build", kind: "start", at: T, who: "Builder" },
    { phase: "build", kind: "end", at: T, who: "Builder" },
    { phase: "checker", kind: "start", at: T, who: "Checker" },
  ]);
  const html = await board(db);
  assert.match(tile(html, "Checker"), /<small class="since" title="[^"]*Checker · Nov 10 9:15 PM MT">(Nov 10|9:15 PM)<\/small>/);
  assert.match(tile(html, "Build"), /<small class="since" title="[^"]*Builder · Nov 10 9:15 PM MT">(Nov 10|9:15 PM)<\/small>/);
});

test("the tile shows only the time (today) or the date (another day); the role and the full stamp are in the hover (Designer F1 and F2)", () => {
  const src = (re) => page.match(re)[0];
  const mtShort = new Function(`${src(/const MT_ZONE=[^\n]*/)}\n${src(/function mtShort[^\n]*/)}\nreturn mtShort`)();
  assert.equal(mtShort(T, T + 10 * MIN), "9:15 PM", "began today: the time");
  assert.equal(mtShort(T, T + 24 * 60 * MIN), "Nov 10", "began on another day: the date");
  assert.equal(mtShort(T, T + 3 * 24 * 60 * MIN), "Nov 10");
  assert.match(page, /\.step small\.since\{text-transform:none\}/, "a timestamp, not the tile's uppercase mono (its opacity went in #C1024: dimmed text failed 4.5:1)");
});

test("a lane phase names the lane's role whatever an old row says, and the page's lane map is the Worker's (Checker F1)", async () => {
  const m = page.match(/const LANE_ROLE=(\{[^}]*\})/)[1];
  assert.deepEqual(new Function(`return ${m}`)(), Object.fromEntries(Object.entries(PHASE_LANES)), "page and Worker agree");
  const db = await seed();
  await writeEvidence(db, T, "probe", "cards.c1", lit("checker"));
  await db.prepare("UPDATE phase_history SET who = 'Boardsmith' WHERE phase = 'checker' AND kind = 'start'").run();
  await writeEvidence(db, T + 12 * MIN, "probe", "cards.c1", lit("ship"));
  await db.prepare("UPDATE phase_history SET who = 'Checker' WHERE phase = 'ship' AND kind = 'start'").run();
  assert.deepEqual((await hist(db)).filter((h) => h.kind === "start").map((h) => h.who), ["Builder", "Boardsmith", "Checker"], "the old rows really are wrong");
  const html = await board(db);
  assert.match(tile(html, "Checker"), /Checker · Nov 10 9:15 PM MT"/);
  assert.match(tile(html, "Ship"), /Release · Nov 10 9:27 PM MT"/);
  assert.match(tile(html, "Build"), /Builder · Nov 10 9:15 PM MT"/, "an early phase keeps the row's role");
});

test("without derived times the page still takes a phase's FIRST start from the history, and a live row is no work phase (Checker F2)", async () => {
  const db = await seed();
  for (const [m, p] of [[0, "checker"], [12, "ship"], [24, "checker"], [36, "ship"]]) await writeEvidence(db, T + m * MIN, "probe", "cards.c1", lit(p));
  const live = await seed();
  for (const [m, p] of [[0, "ship"], [12, "live"]]) await writeEvidence(live, T + m * MIN, "probe", "cards.c1", lit(p));
  assert.deepEqual(Object.keys(timesOfHistory((await readView(live, Date.now())).history).c1).sort(), ["build", "ship"], "live is not a work phase");
  const view = await readView(db, Date.now());
  const col = compatView(view).collections;
  col.derived[0].times = {};
  const html = render(page, col).board;
  assert.match(tile(html, "Checker"), /Nov 10 9:15 PM MT"/, "the first checker start, not the second at 9:39");
  assert.match(tile(html, "Ship"), /Nov 10 9:27 PM MT"/);
});

test("no build row is invented for a card first read at build, at plan, or already live, or that has history", async () => {
  for (const p of ["build", "plan", "live"]) {
    const db = await seed();
    await writeEvidence(db, T, "probe", "cards.c1", lit(p));
    assert.deepEqual((await hist(db)).map((h) => h.phase), [p], `first read at ${p}`);
  }
  const db = await seed();
  await db.prepare("INSERT INTO phase_history (card_id, phase, kind, at, who, source) VALUES ('c1', 'build', 'start', ?, 'Builder', 'tool')").bind(T - 9 * MIN).run();
  await writeEvidence(db, T, "probe", "cards.c1", lit("checker"));
  assert.deepEqual((await hist(db)).map((h) => [h.phase, h.kind]), [["build", "start"], ["build", "end"], ["checker", "start"]]);
});

test("the who of a row is the phase's lane, whoever else works the card (ship said Checker, Security; checker said Boardsmith)", async () => {
  assert.equal(whoForPhase("c1", "ship", { Checker: { state: "working", card: "c1" } }, "Builder"), "Release");
  assert.equal(whoForPhase("c1", "ship", { Security: { state: "working", card: "c1" } }, "Builder"), "Release");
  assert.equal(whoForPhase("c1", "checker", { Boardsmith: { state: "working", card: "c1" } }, "Boardsmith"), "Checker");
  assert.equal(whoForPhase("c1", "build", { Designer: { state: "working", card: "c1" } }, "Builder"), "Designer", "an early phase still takes the agent working the card");
  assert.equal(whoForPhase("c1", "build", {}, "Builder"), "Builder");
  const db = await seed();
  await writeEvidence(db, T - MIN, "probe", "agents", { Checker: { state: "working", card: "c1" }, Security: { state: "working", card: "c1" } });
  await writeEvidence(db, T, "probe", "cards.c1", lit("ship"));
  assert.equal((await hist(db)).find((h) => h.phase === "ship").who, "Release");
});

test("a flip between phases does not restart a phase's time: the start stays the first time it began", async () => {
  const db = await seed();
  for (const [m, p] of [[0, "checker"], [12, "ship"], [24, "checker"], [36, "ship"]]) await writeEvidence(db, T + m * MIN, "probe", "cards.c1", lit(p));
  const view = await readView(db, Date.now());
  assert.deepEqual(timesOfHistory(view.history), { c1: { build: { start: T }, checker: { start: T }, ship: { start: T + 12 * MIN } } });
  assert.deepEqual(compatView(view).collections.derived[0].times, timesOfHistory(view.history));
  const html = render(page, compatView(view).collections).board;
  assert.match(tile(html, "Checker"), /Nov 10 9:15 PM MT">/, "checker still says 9:15, not the second 9:39");
  assert.match(tile(html, "Ship"), /Nov 10 9:27 PM MT">/, "ship says its first start, 9:27, not 9:51");
});

test("a finished tile keeps its start time beside the lit one; a wait row and a phase with no row show nothing", async () => {
  const db = await seed();
  for (const [m, p] of [[0, "checker"], [20, "ship"]]) await writeEvidence(db, T + m * MIN, "probe", "cards.c1", lit(p));
  await db.prepare("INSERT INTO phase_history (card_id, phase, kind, at, who, source, wait) VALUES ('c1', 'security', 'start', ?, 'Security', 'tool', 'busy')").bind(T + 5 * MIN).run();
  assert.equal(timesOfHistory((await readView(db, Date.now())).history).c1.security, undefined, "a wait is not a phase start");
  const html = await board(db);
  assert.match(tile(html, "Checker"), /Nov 10 9:15 PM MT">/);
  assert.match(tile(html, "Ship"), /Release · Nov 10 9:35 PM MT">/);
  assert.equal(/class="since"/.test(tile(html, "Language") ?? ""), false);
  assert.equal(/class="since"/.test(tile(html, "Security") ?? ""), false);
});

test("no evidence, no time: a card with no readings has no times and no tile shows a start", async () => {
  const db = await seed();
  const view = await readView(db, Date.now());
  assert.deepEqual(compatView(view).collections.derived[0].times, {});
  assert.equal(/class="since"/.test(await board(db)), false);
  assert.deepEqual(timesOfHistory(undefined), {});
});

// #C859's checker, ship, checker, ship flipping between 9:15 and 9:27 pm: the probe read ONE card as several rows (a signed v1 frozen at a later phase
// beside an unsigned v2), and which row's phase the card took changed from run to run. #C886 collapsed the versions into one row; the phase no
// longer depends on the order the tips come in.
test("the probe's phase for a card with a signed v1 and a new v2 is v2's, whichever order the tips come in (no flip at the source)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-phase-tile-")), git = (a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]); git(["commit", "-q", "--allow-empty", "-m", "base"]);
  const sha = {};
  for (const n of ["build/a-card", "build/a-card-v2"]) { git(["switch", "-q", "main"]); git(["switch", "-q", "-c", n]); git(["commit", "-q", "--allow-empty", "-m", `${n}\n\nBoard-Id: a-card`]); sha[n] = git(["rev-parse", "HEAD"]).trim(); git(["update-ref", `refs/remotes/origin/${n}`, sha[n]]); }
  git(["switch", "-q", "main"]); git(["update-ref", "refs/remotes/origin/main", "main"]);
  git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", sha["build/a-card"]]);
  const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
  const tips = [{ branch: "build/a-card", sha: sha["build/a-card"], at: T - 5000, message: "m\n\nBoard-Id: a-card" }, { branch: "build/a-card-v2", sha: sha["build/a-card-v2"], at: T, message: "m\n\nBoard-Id: a-card" }, { branch: "main", sha: "x", at: T, message: "" }];
  const read = (t) => cardState({ id: "a-card", num: 881, level: "Full", phase: "plan" }, { git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, tips: t, live: null, versionPattern: null }, cfg, T);
  const a = read(tips), b = read([...tips].reverse());
  assert.equal(a.phase, b.phase);
  assert.equal(a.headSha12, sha["build/a-card-v2"].slice(0, 12));
  assert.deepEqual(a.signed, []);
});
