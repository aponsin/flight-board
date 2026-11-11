// #C915 (incident 11-11): a card whose newer tip is live stops dispatching its old tip; a landed card reads landed, not checker; an open hold end
// raises no stall and no dispatch; a held card shows "Held: <reason>" and never reads slow; a card slow with no reason raises one stall.
//   part 1  the older tip of a card whose Board-Id commit is on main is retired (probe, collector/state.mjs cardState)
//   (a)     a card landed on main (ship + onMain, "landed" in the dispatch's and the stall rule's words) is nobody's turn at Checker
//   (b)     an open hold_end (an open ask, an open card, a check date to come) raises no stall and no dispatch
//   (c)     the tile says "Held: <reason>"; its phase cell says held, never slow; a moving card has no Held line; a merely slow card still says slow
//   (d)     a card past its estimate with no reason raises one stall to Manager
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadBoard } from "./harness.mjs";
import { createCard, updateCard, createAsk, writeEvidence, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { holdOpen as workerHoldOpen, phaseMedians, slowLine, slowWakes, SHIP_SLOW_MS } from "../worker/board-rules.mjs";
import { cardState } from "../collector/state.mjs";
import { turnsOf, dispatchInput, holdOpen as dispatchHoldOpen } from "../collector/store-dispatch.mjs";

const T = 1_800_000_000_000, MIN = 60_000, H = 3_600_000;

// ---- the repository fixture: a card with an old tip (v1) on its branch, and its v2 on main (the v2 branch was deleted at merge) ----
function fixture({ v1Signed = true, v2Branch = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-c915-"));
  const git = (a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = (file, text, msg) => { writeFileSync(join(dir, file), text); git(["add", file]); git(["commit", "-q", "-m", msg]); return git(["rev-parse", "HEAD"]).trim(); };
  git(["init", "-q", "-b", "main"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  const base = commit("base.txt", "base\n", "base");
  git(["switch", "-q", "-c", "build/a-card"]);
  const v1 = commit("one.txt", "v1\n", "v1\n\nBoard-Id: a-card");
  git(["update-ref", "refs/remotes/origin/build/a-card", v1]);
  if (v1Signed) { git(["notes", "--ref=refs/notes/checker", "add", "-m", "PASS", v1]); git(["notes", "--ref=refs/notes/security", "add", "-m", "PASS", v1]); }
  git(["switch", "-q", "main"]);
  commit("other.txt", "someone else's work\n", "other work on main");
  let v2;
  if (v2Branch) { git(["switch", "-q", "-c", "build/a-card-v2"]); v2 = commit("two.txt", "v2\n", "v2\n\nBoard-Id: a-card"); git(["update-ref", "refs/remotes/origin/build/a-card-v2", v2]); git(["switch", "-q", "main"]); git(["merge", "-q", "--ff-only", "build/a-card-v2"]); }
  else v2 = commit("two.txt", "v2\n", "v2, squashed\n\nBoard-Id: a-card");
  git(["update-ref", "refs/remotes/origin/main", v2]);
  return { git, v1, v2, base };
}
const cfg = { phases: [["plan"], ["build"], ["test"], ["checker"], ["security"], ["ship"], ["live"]], skips: [], collector: { notes: { checker: "x", security: "y" }, buildPhase: "build", shipPhase: "ship", livePhase: "live", mainBranch: "main", repos: [] } };
const read = (fx, { live = null, tips = null } = {}) => cardState({ id: "a-card", num: 915, level: "Quick", phase: "plan" },
  { git: fx.git, remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, live, versionPattern: null,
    tips: tips ?? [{ branch: "build/a-card", sha: fx.v1, at: T - H, message: "v1\n\nBoard-Id: a-card" }, { branch: "main", sha: fx.v2, at: T, message: "" }] }, cfg, T);

test("part 1: a card whose v2 (Board-Id trailer) is on main is that commit, not its signed v1 behind main; live once deployed", () => {
  const fx = fixture();
  const s = read(fx);
  assert.equal(s.onMain, true, "the card is the main commit");
  assert.equal(s.phase, "ship", "landed: on main, not deployed");
  assert.equal(s.headSha12, fx.v2.slice(0, 12), "not v1's sha");
  assert.equal(s.behindMain, undefined, "no 're-cut' reading: v1 is not worked any more");
  assert.equal(s.branches, undefined, "one row, not two");
  const live = read(fx, { live: fx.v2 });
  assert.equal(live.phase, "live"); assert.equal(live.onMain, true);
  assert.equal(live.liveVersion, null); // (a live card is skipped by dispatchInput before any turn is chosen)
});

test("part 1 (fixture of two tips, only the newer is live): the old tip's own reading was re-cut; the newer one on main retires it", () => {
  const fx = fixture();
  // The old tip read alone (no trailer on main to find: the repository seen before v2 landed) is signed and behind main: the owner's re-cut.
  const alone = cardState({ id: "a-card", num: 915, level: "Quick", phase: "plan" },
    { git: (a) => (a[0] === "log" && a.some((x) => String(x).startsWith("--grep=")) ? "" : fx.git(a)), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, live: null, versionPattern: null,
      tips: [{ branch: "build/a-card", sha: fx.v1, at: T - H, message: "v1\n\nBoard-Id: a-card" }, { branch: "main", sha: fx.v2, at: T, message: "" }] }, cfg, T);
  assert.equal(alone.onMain, false);
  assert.equal(alone.behindMain, true, "this is what the board dispatched to Builder for the old v1");
  assert.deepEqual(turnsOf({ owner_role: "Builder", review_level: "Quick" }, alone).map((t) => t.step), ["recut"]);
  // With the main commit visible the card is retired: no recut turn.
  const now = read(fx);
  assert.deepEqual(turnsOf({ owner_role: "Builder", review_level: "Quick" }, now), [], "landed, no repo word: nobody (the lead closes it)");
  assert.deepEqual(turnsOf({ owner_role: "Builder", review_level: "Quick", repo: "flight-board" }, now).map((t) => t.step), ["pair"], "landed on the board's own repository: the deploy pair, never a re-cut");
  // A v2 branch that is still there and on main is the same card too (#C886 kept).
  const kept = read(fixture({ v2Branch: true }), { tips: null });
  assert.equal(kept.onMain, true);
});

test("(a) a card landed on main reads ship + onMain ('landed'), not checker, and no stall 'waits at Checker' or 'waits at Ship' is raised for it", async () => {
  const fx = fixture({ v1Signed: false }); // the stale v1 tip is READY with no review note: it reads checker, and Checker is idle
  const alone = cardState({ id: "a-card", num: 915, level: "Quick", phase: "plan" },
    { git: (a) => (a[0] === "log" && a.some((x) => String(x).startsWith("--grep=")) ? "" : fx.git(a)), remote: "origin", main: "main", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, live: null, versionPattern: null,
      tips: [{ branch: "build/a-card", sha: fx.v1, at: T - H, message: "v1\n\nBoard-Id: a-card" }, { branch: "main", sha: fx.v2, at: T, message: "" }] }, cfg, T);
  assert.equal(alone.phase, "checker", "the old reading");
  const landed = read(fx);
  assert.equal(landed.phase, "ship"); assert.equal(landed.onMain, true);
  assert.deepEqual(turnsOf({ owner_role: "Builder", review_level: "Quick" }, landed).filter((t) => t.role === "Checker"), []);
  const world = async (ev) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Builder", repo: "flight-board" }); // the board's own repository: its landed card waits for the owner's deploy
    await writeEvidence(db, T, "probe", "cards.card-a", ev);
    await writeEvidence(db, T, "probe", "agents", { Checker: { state: "idle", tool: null, card: null, since: T }, Release: { state: "idle", tool: null, card: null, since: T } });
    return db;
  };
  const stale = await world({ lit: ["checker"], phase: "checker", onMain: false });
  assert.equal((await wakeAsk(stale, T + 20 * MIN)).count, 1, "control: the old reading wakes Manager, 'waits at Checker'");
  assert.match((await takeInbox(stale, T + 21 * MIN)).stalls[0].reason, /waits at Checker/);
  const db = await world({ lit: ["ship"], phase: "ship", onMain: true, headSha12: landed.headSha12 });
  assert.equal((await wakeAsk(db, T + 20 * MIN)).count, 0, "landed: Release has nothing to land, no stall");
  assert.deepEqual((await takeInbox(db, T + 21 * MIN)).stalls, []);
});

// ---- (b) an open hold_end raises no stall and no dispatch ----
const answeredAsk = async (db) => {
  const a = await createAsk(db, T, { type: "Action", title: "Run the pair", asked_by: "Manager", steps: ["one"], expect: "ok" });
  assert.equal(a.ok, true, JSON.stringify(a));
  await db.prepare("UPDATE asks SET answered_at = ?, answer_taken_at = ? WHERE id = ?").bind(T, T, a.id).run(); // answered, still open: no 10-minute ask line
  return a.id;
};
test("(b) a card with an open hold_end raises no stall; when the ask closes the stall comes back", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Builder" });
  await writeEvidence(db, T, "probe", "cards.card-a", { lit: ["checker"], phase: "checker" });
  await writeEvidence(db, T, "probe", "agents", { Checker: { state: "idle", tool: null, card: null, since: T } });
  const ask = await answeredAsk(db);
  const r = await updateCard(db, T + 1, "Manager", { id: "card-a", hold_end: ask });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await wakeAsk(db, T + 30 * MIN)).count, 0, "held by an open ask: no 'waits at Checker'");
  await db.prepare("UPDATE asks SET closed_at = ? WHERE id = ?").bind(T + 40 * MIN, ask).run();
  assert.equal((await wakeAsk(db, T + 41 * MIN)).count, 1, "the end has come: the wait is a stall again");
  assert.match((await takeInbox(db, T + 42 * MIN)).stalls[0].reason, /waits at Checker/);
});

test("(b) a check date still to come is an open hold too (the store's rule), and holdOpen is one rule in the Worker and the dispatch", () => {
  const passed = (s) => (ref) => s.has(ref);
  const cases = [
    [{ hold_end: "ask-1" }, new Set(), true], [{ hold_end: "ask-1" }, new Set(["ask-1"]), false], [{ hold_end: " " }, new Set(), false], [{}, new Set(), false],
    [{ check_at: T + H }, new Set(), true], [{ check_at: T - H }, new Set(), false], [{ hold_end: "ask-1", check_at: T + H }, new Set(["ask-1"]), true],
  ];
  for (const [c, ends, want] of cases) {
    assert.equal(workerHoldOpen(c, T, ends), want, JSON.stringify(c));
    assert.equal(dispatchHoldOpen(c, T, passed(ends)), want, JSON.stringify(c));
  }
});

test("(b) a card with an open hold_end is not dispatched; once its ask is closed, or its card live, it is", () => {
  const view = (extra = {}, asks = [], dep = null) => ({
    cards: [{ id: "card-a", num: 900, owner_role: "Builder", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", hold_end: "ask-1", ...extra }, ...(dep ? [dep] : [])],
    asks,
    evidence: {
      agents: { readAt: T - 5_000, value: { Builder: { state: "idle", lastActivityAt: T - 20 * MIN, since: T - 20 * MIN } } },
      "cards.card-a": { readAt: T - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: "8b3855f0f672", signed: [] } },
      ...(dep ? { "cards.dep-card": { readAt: T - 5_000, value: { lit: ["live"], phase: "live" } } } : {}),
    },
  });
  const turns = (v) => dispatchInput(v, T).cards.map((k) => k.turns.length);
  assert.deepEqual(turns(view({}, [{ id: "ask-1", closed_at: null, answered_at: T - MIN }])), [], "open ask: held, not dispatched");
  assert.deepEqual(turns(view({})), [], "an id the view does not know stays open");
  assert.deepEqual(turns(view({}, [{ id: "ask-1", closed_at: T - MIN, answered_at: T - MIN }])), [1], "the ask is closed: the hold has ended, the card is dispatched again");
  assert.deepEqual(turns(view({ hold_end: "dep-card" }, [], { id: "dep-card", num: 901, owner_role: "Builder", paused: 0, dropped: 0 })), [1], "the card it waits for is live: ended");
  assert.deepEqual(turns(view({ hold_end: null, check_at: T + H })), [], "a check date to come");
});

// ---- (c) the page ----
const draw = (f) => { const b = loadBoard(); b.state.steps = []; b.state.waiting = []; return b.initRow(b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", phase: "ship", ...f }))); };
const SLOW_SHIP = { shipAt: Date.now() - 30 * MIN };
test("(c) waiting_on shows on the tile as 'Held: <reason>'; a hold end alone shows 'Held: waiting on <id>'", () => {
  assert.match(draw({ waitingOn: "Checker: a verdict" }), /<span class="held-line">Held: Checker: a verdict, until no end set<\/span>/);
  assert.match(draw({ holdEnd: "t-100" }), /<span class="held-line">Held: waiting on t-100<\/span>/);
  assert.match(draw({ waitingOn: "the owner", holdEnd: "t-100" }), /Held: the owner, until t-100/);
});

test("(c) the reason is escaped like every card text on the page", () => {
  const html = draw({ waitingOn: "<b>x</b>" });
  assert.match(html, /Held: &lt;b&gt;x&lt;\/b&gt;/);
  assert.equal(html.includes("<b>x</b>"), false);
  assert.equal(draw({ holdEnd: "<i>y</i>" }).includes("<i>y</i>"), false);
});

test("(c) a held card never reads slow: its phase cell says held, not 'slow (est.)'", () => {
  const slow = draw({ ...SLOW_SHIP });
  assert.match(slow, /slow \(est\.\) \d+\/~10 min/, "control: the same card with no reason reads slow");
  for (const f of [{ waitingOn: "the owner's install" }, { holdEnd: "t-100" }, { blocked: "keys", status: "blocked" }]) {
    const held = draw({ ...SLOW_SHIP, ...f });
    assert.match(held, /<small data-shipat="1">held \d+ min<\/small>/, JSON.stringify(f));
    assert.equal(/slow/i.test(held.replace(/class="[^"]*"/g, "")), false, `no 'slow' word: ${JSON.stringify(f)}`);
  }
});

test("(c) still allowed: a card moving normally has no Held line, and a card that is merely slow with nobody's reason still says slow", () => {
  const moving = draw({ shipAt: Date.now() - 3 * MIN });
  assert.equal(/Held:|held-line/.test(moving), false);
  assert.match(moving, /tests \(est\.\) \d+\/~10 min/);
  const slow = draw({ ...SLOW_SHIP });
  assert.equal(/Held:|held-line/.test(slow), false);
  assert.match(slow, /slow \(est\.\) \d+\/~10 min/);
});

// ---- (d) slow with no reason ----
const slowWorld = async (extra = {}) => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Builder" });
  await writeEvidence(db, T, "probe", "cards.card-a", { lit: ["ship"], phase: "ship", onMain: false }); // no agent roster: the #C732 stall stays out of it
  if (Object.keys(extra).length) await updateCard(db, T + 1, "Manager", { id: "card-a", ...extra });
  return db;
};
test("(d) a card past its estimate with no waiting_on and no hold raises one stall to Manager, once", async () => {
  const db = await slowWorld();
  assert.equal((await wakeAsk(db, T + SHIP_SLOW_MS - MIN)).count, 0, "not yet slow");
  assert.equal((await wakeAsk(db, T + SHIP_SLOW_MS + MIN)).count, 1);
  assert.deepEqual((await takeInbox(db, T + 12 * MIN + 1000)).stalls.map((s) => s.reason), ["#C1 is slow with no reason: add one or unstick it"]);
  assert.equal(slowLine(1), "#C1 is slow with no reason: add one or unstick it");
  // The probe rewrites the card's reading every minute; without that a 2 h old reading would raise #C927's stale-copy stall, which is not what is tested here.
  for (const m of [14, 30, 120]) {
    await writeEvidence(db, T + m * MIN - 1000, "probe", "cards.card-a", { lit: ["ship"], phase: "ship", onMain: false });
    assert.equal((await wakeAsk(db, T + m * MIN)).count, 0, `quiet at ${m} min`);
  }
});

test("(d) a card already named by a 'waits at' line is not named twice: that line is its one stall", async () => {
  const db = await slowWorld();
  await writeEvidence(db, T + 1, "probe", "agents", { Release: { state: "idle", tool: null, card: null, since: T } });
  assert.equal((await wakeAsk(db, T + 15 * MIN)).count, 1);
  assert.deepEqual((await takeInbox(db, T + 16 * MIN)).stalls.map((s) => s.reason), [`#C1 waits at Ship 15 min, Release idle since ${new Date(T).toISOString().slice(11, 16)}Z`]);
});

test("(d) a card with a reason raises no slow stall: waiting_on, an open hold end, a pause; and one that moved on to live", async () => {
  const ask = async (db) => answeredAsk(db);
  assert.equal((await wakeAsk(await slowWorld({ waiting_on: "the owner's install" }), T + 15 * MIN)).count, 0, "waiting_on");
  const withEnd = await slowWorld(); await updateCard(withEnd, T + 2, "Manager", { id: "card-a", hold_end: await ask(withEnd) });
  assert.equal((await wakeAsk(withEnd, T + 15 * MIN)).count, 0, "open hold_end");
  assert.equal((await wakeAsk(await slowWorld({ paused: true, next_note: "parked" }), T + 15 * MIN)).count, 0, "paused");
  const live = await slowWorld(); await writeEvidence(live, T + 5 * MIN, "probe", "cards.card-a", { lit: ["live"], phase: "live", onMain: true });
  assert.equal((await wakeAsk(live, T + 30 * MIN)).count, 0, "live");
});

test("(d) other phases are slow past twice their usual time (the median of finished phases, three or more)", () => {
  const row = (id, card_id, phase, kind, at) => ({ id, card_id, phase, kind, at });
  const rows = [];
  [10, 20, 30].forEach((m, k) => { rows.push(row(k * 2 + 1, `c${k}`, "checker", "start", T), row(k * 2 + 2, `c${k}`, "checker", "end", T + m * MIN)); });
  rows.push(row(90, "c9", "build", "start", T), row(91, "c9", "build", "end", T + MIN), row(92, "c9", "ship", "start", T)); // one build sample, a ship still open
  assert.deepEqual(phaseMedians(rows), { checker: 20 * MIN }, "a median only from 3 or more finished rows; an open start counts for nothing");
  assert.deepEqual(phaseMedians(undefined), {});
});

// ---- Checker's findings on b07ac69 ----
// The probe rewrites a card's reading every minute; a test that jumps hours does the same, or #C927's stale-copy line would answer instead.
const reading = (db, at) => writeEvidence(db, at, "probe", "cards.card-a", { lit: ["ship"], phase: "ship", onMain: false });

test("(d) F1: a second slow spell wakes Manager again; the first spell's read row does not silence it", async () => {
  const db = await slowWorld();
  assert.equal((await wakeAsk(db, T + 12 * MIN)).count, 1, "spell one");
  assert.deepEqual((await takeInbox(db, T + 12 * MIN + 1000)).stalls.map((s) => s.reason), [slowLine(1)], "Manager reads it");
  await updateCard(db, T + 13 * MIN, "Manager", { id: "card-a", waiting_on: "the owner's install" });
  assert.equal((await wakeAsk(db, T + 14 * MIN)).count, 0, "a reason was given: the spell is over");
  await updateCard(db, T + 20 * MIN, "Manager", { id: "card-a", waiting_on: null });
  await reading(db, T + 29 * MIN);
  assert.equal((await wakeAsk(db, T + 30 * MIN)).count, 1, "slow again with no reason: Manager hears of it again");
  assert.deepEqual((await takeInbox(db, T + 30 * MIN + 1000)).stalls.map((s) => s.reason), [slowLine(1)]);
  assert.equal((await wakeAsk(db, T + 40 * MIN)).count, 0, "and once, not every minute");
});

test("(b) F2: a hold that is only a hold_end on an answered ask nobody closed is a line to Manager after 2 h, not a card hidden for ever", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Release" });
  await reading(db, T);
  const ask = await answeredAsk(db);
  assert.equal((await updateCard(db, T + 1, "Manager", { id: "card-a", hold_end: ask })).ok, true);
  let first = null;
  for (let h = 1; h <= 72; h++) { await reading(db, T + h * H); const n = (await wakeAsk(db, T + h * H + MIN)).count; if (n > 0 && first === null) first = h; }
  assert.equal(first, 2, "silent for the first hour, a line once 2 h have passed");
  const stalls = (await takeInbox(db, T + 72 * H + MIN)).stalls.map((s) => s.reason);
  assert.equal(stalls.length, 1, "one line, not one an hour");
  assert.match(stalls[0], new RegExp(`^#C1 waits on ${ask}, whose end has not come after 2 h: close it or lift the hold \\(since `));
  await db.prepare("UPDATE asks SET closed_at = ? WHERE id = ?").bind(T + 73 * H, ask).run();
  await reading(db, T + 74 * H - MIN);
  assert.equal((await wakeAsk(db, T + 74 * H)).count, 1, "the ask closed: the hold has ended and the card's own rules take over (a card 74 h at ship is slow)");
  assert.deepEqual((await takeInbox(db, T + 74 * H + MIN)).stalls.map((s) => s.reason), [slowLine(1)], "that line, not the hold line again");
});

test("F3: a card closed as done is never slow, and a hold_end naming a done card has ended (Worker and dispatch)", () => {
  const card = { id: "card-a", num: 5, paused: 0, dropped: 0, done_at: T - MIN, waiting_on: null };
  const evidence = { "card-a": { lit: ["ship"], phase: "ship", onMain: false } };
  const phaseStart = new Map([["card-a|ship", T - 2 * H]]);
  assert.deepEqual(slowWakes({ now: T, cards: [card], evidence, openAskCards: new Set(), phaseStart, medians: {}, endsPassed: new Set() }), [], "done: not slow");
  assert.equal(slowWakes({ now: T, cards: [{ ...card, done_at: null }], evidence, openAskCards: new Set(), phaseStart, medians: {}, endsPassed: new Set() }).length, 1, "control: the same card, not done, is slow");
  const view = (dep) => ({
    cards: [{ id: "card-a", num: 900, owner_role: "Builder", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", hold_end: "dep-card" }, { id: "dep-card", num: 901, owner_role: "Builder", paused: 0, dropped: 0, ...dep }],
    asks: [],
    evidence: {
      agents: { readAt: T - 5_000, value: { Builder: { state: "idle", lastActivityAt: T - 20 * MIN, since: T - 20 * MIN } } },
      "cards.card-a": { readAt: T - 5_000, value: { lit: ["checker"], phase: "checker", headSha12: "8b3855f0f672", signed: [] } },
      "cards.dep-card": { readAt: T - 5_000, value: { lit: ["build"], phase: "build" } },
    },
  });
  const dispatched = (v) => dispatchInput(v, T).cards.filter((k) => k.id === "card-a").map((k) => k.turns.length);
  assert.deepEqual(dispatched(view({})), [], "the card it waits for is open: held");
  assert.deepEqual(dispatched(view({ done_at: T - MIN })), [1], "the card it waits for is done: the hold has ended, dispatched again");
});
