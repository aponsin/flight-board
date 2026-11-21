// #C1409, Checker 2's F3: six places where a called-off (outdated) ask is left out of "open" each survived the whole suite when the exclusion was removed alone.
// One test per place, each with a control (an ordinary open ask) showing the same setup still counts. Fictional board.
//  (a) the store's stall sync: openAskCards (a card whose only ask is called off is no longer held, so its slow line is raised)
//  (b) the page's ownerWait (a called-off ask is not the owner's wait on its card)
//  (c) the dispatch's endPassed (a hold that ends on a called-off ask has ended)
//  (d) the dispatch's first-startable pick (a card with a called-off ask is not skipped)
//  (e) derivedDoc's waitAsk (an install wait never names a called-off ask)
//  (f) the weekly branch sweep (a called-off sweep ask does not block the next one)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";
import { createCard, createAsk, outdateAsk, writeEvidence, syncBranchSweep } from "../worker/board-store.mjs";
import { slowLine, SHIP_SLOW_MS } from "../worker/board-rules.mjs";
import { derivedDoc } from "../worker/compat-view.mjs";
import { readView } from "../worker/board-store.mjs";
import { wakeAsk, takeInbox } from "./helpers/beating-store.mjs";
import { dispatchRun } from "../collector/store-dispatch.mjs";

const T = 1_800_000_000_000, MIN = 60_000, DAY = 86_400_000;
const terminal = (extra = {}) => ({ type: "Terminal", title: "Clean up the old folders", asked_by: "Manager", commands: ["ls ~/Documents/Code"], ...extra });
const callOff = (db, id, now = T + MIN) => outdateAsk(db, now, "Manager", { id, reason: "Manager changed the plan" });

test("(a) the store's stall sync: a card at ship whose only ask is called off is slow like any card; one with an ordinary open ask is held (control)", async () => {
  const run = async (called) => {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "c900-thing", title: "Thing", owner_role: "Boardsmith" });
    const ask = await createAsk(db, T, terminal({ card_id: "c900-thing" }));
    assert.equal(ask.ok, true, JSON.stringify(ask));
    if (called) assert.equal((await callOff(db, ask.id)).ok, true);
    await writeEvidence(db, T + 2 * MIN, "probe", "cards.c900-thing", { lit: ["ship"], phase: "ship", headSha12: "aaaaaaaaaaaa", signed: [], onMain: false });
    await wakeAsk(db, T + SHIP_SLOW_MS + 5 * MIN);
    const num = (await db.prepare("SELECT num FROM cards WHERE id = 'c900-thing'").first()).num;
    return { num, said: (await takeInbox(db, T + SHIP_SLOW_MS + 6 * MIN)).stalls.map((s) => s.reason) };
  };
  const held = await run(false);
  assert.deepEqual(held.said.filter((r) => r.includes(slowLine(held.num))), [], "control: an open ask holds the card, so no slow line");
  const off = await run(true);
  assert.deepEqual(off.said.filter((r) => r.includes(slowLine(off.num))), [slowLine(off.num)], "called off: the card is slow like any other");
});

test("(b) the page: a called-off ask is not the owner's wait on its card, and an ordinary ask is (control)", () => {
  const b = loadNames(["ownerWait"]);
  const ask = (more = {}) => ({ id: "a1", kind: "action", text: "Run it", since: Date.now() - 9e5, initiative: "i1", steps: [], ...more });
  Object.assign(b.state, { waiting: [ask()], messages: [], threads: [], initRaw: [], ideas: [], todo: [] });
  assert.equal(b.ownerWait({ id: "i1" })?.id, "a1", "control");
  Object.assign(b.state, { waiting: [ask({ outdated: { at: Date.now() - 6e4, by: "Manager", reason: "No longer needed." } })] });
  assert.equal(b.ownerWait({ id: "i1" }), null);
});

const agents = { Manager: { state: "idle", lastActivityAt: T - 20 * MIN, since: T - 20 * MIN, card: null }, Builder: { state: "idle", lastActivityAt: T - 20 * MIN, since: T - 20 * MIN, card: null } };
const dispatchView = (cards, asks) => ({ cards, asks, evidence: { agents: { readAt: T - 1000, value: agents } } });
const dispatched = (v) => dispatchRun(v, { dir: mkdtempSync(`${tmpdir()}/od-`), roster: ["Manager", "Builder"], lead: "Manager", now: T }).items;
const asRow = (id, num, extra = {}) => ({ id, num, owner_role: "Builder", waiting_on: null, paused: 0, dropped: 0, updated_at: T - 5 * MIN, ...extra });
const askRow = (id, num, card, extra = {}) => ({ id, num, type: "Terminal", card_id: card, closed_at: null, answered_at: null, withdrawn_at: null, outdated_at: null, ...extra });

test("(c) the dispatch: a card on hold whose end is a called-off ask is Builder's again, and one whose end is an open ask stays on hold (control)", () => {
  const held = (ref) => asRow("c900-thing", 900, { hold_end: ref });
  const items = (ask) => dispatched(dispatchView([held("t1")], [ask]));
  assert.deepEqual(items(askRow("t1", 1, null)), [], "control: the ask is open, the hold's end has not come");
  const off = items(askRow("t1", 1, null, { outdated_at: T - MIN }));
  assert.deepEqual(off.map((i) => i.card), ["c900-thing"], "called off: the hold's end has come");
});

test("(d) the dispatch: the first card to start is not skipped for having a called-off ask; an ordinary open ask still skips it (control)", () => {
  const cards = [asRow("c901-first", 901, { queue_pos: 1 }), asRow("c902-second", 902, { queue_pos: 2 })];
  const pick = (first) => dispatched(dispatchView(cards, [askRow("t1", 1, "c901-first", first)])).map((i) => i.card);
  assert.deepEqual(pick({}), ["c902-second"], "control: the first card is asked, so the second is the one started");
  assert.deepEqual(pick({ outdated_at: T - MIN }), ["c901-first"], "called off: the first card is the one started");
});

test("(e) the install wait names its newest open ask, never a called-off one", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "r1", title: "Thing", owner_role: "Boardsmith", repo: "board" });
  const open = await createAsk(db, T, terminal({ card_id: "r1", title: "Deploy it" }));
  const off = await createAsk(db, T + 1, terminal({ card_id: "r1", title: "Deploy it the old way" }));
  await writeEvidence(db, T, "probe", "cards.r1", { lit: ["ship"], phase: "ship", onMain: true });
  const waitAsk = async () => derivedDoc(await readView(db, T + 1000)).cards.r1.waitAsk;
  assert.equal(await waitAsk(), off.num, "control: the newest open ask");
  await callOff(db, off.id, T + 2);
  assert.equal(await waitAsk(), open.num, "the called-off ask is passed over for the one before it");
  await callOff(db, open.id, T + 3);
  assert.equal(await waitAsk(), undefined, "and with none left the page says no deploy ask yet");
});

test("(f) the weekly branch sweep: a sweep ask the lead called off does not block the next week's", async () => {
  const rb = (...names) => names.map((n, i) => ({ name: n, sha: String(i + 1).repeat(40) }));
  const good = (at) => ({ at, repos: [{ name: "demo-repo", dir: "~/Code/demo-repo", remote: "origin", main: "main", remoteBranches: rb("build/a", "build/b"), localBranches: ["build/a"] }] });
  const db = makeDb();
  await writeEvidence(db, T, "probe", "branches.shipped", good(T));
  const first = await syncBranchSweep(db, T + 1000);
  assert.equal(first.ok, true);
  assert.equal((await callOff(db, first.id, T + MIN)).ok, true);
  await writeEvidence(db, T + 8 * DAY, "probe", "branches.shipped", good(T + 8 * DAY));
  assert.equal((await syncBranchSweep(db, T + 8 * DAY))?.ok, true, "called off and a week old: a new ask");
  const db2 = makeDb();
  await writeEvidence(db2, T, "probe", "branches.shipped", good(T));
  assert.equal((await syncBranchSweep(db2, T + 1000)).ok, true);
  await writeEvidence(db2, T + 8 * DAY, "probe", "branches.shipped", good(T + 8 * DAY));
  assert.equal(await syncBranchSweep(db2, T + 8 * DAY), null, "control: still open after a week, nothing new");
});
