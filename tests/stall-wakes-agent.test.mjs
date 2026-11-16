// #C1097 (11-16, about 5 am to 10 am MT: three signed cards sat with Boardsmith and #C1095 with Release; the stalls were in Manager's inbox only and nothing woke the
// agents): a stall that is 30 minutes old (the time the store first raised it) also gets a DISPATCH line for the stalled role, by the dispatch's own path, and the
// stall still goes to Manager's inbox. The line fires once per stall: a new reason is a new line, the same reason is not printed twice.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, readView } from "../worker/board-store.mjs";
import { wakeAsk, takeInbox, beat } from "./helpers/beating-store.mjs";
import { AGENT_STALL, agentStallRow, agentStallOf, STALL_WAKE_AFTER_MS } from "../worker/board-rules.mjs";
import { agentStallCards, dispatchRun } from "../collector/store-dispatch.mjs";
import { dispatchLine, dispatchPending, dispatchSeen } from "../gate/reset.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const ROSTER = ["Manager", "Checker", "Boardsmith", "Release"], LEAD = "Manager";
const scratch = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "c1097-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// A card at the checker phase since T, Checker idle since T, read at `now` (the probe reads every minute: the readings are fresh at every step).
async function world() {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "card-a", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none" }); // the phase starts at T
  return db;
}
async function step(db, now, { checker = { state: "idle", tool: null, card: null, since: T } } = {}) {
  await beat(db, now - 1000); // the probe posts every minute: the gap since the last step is no outage (#C990)
  await writeEvidence(db, now, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none" });
  await writeEvidence(db, now, "probe", "agents", { Checker: checker, Boardsmith: { state: "idle", tool: null, card: null, since: now - 1000 }, Manager: { state: "idle", tool: null, card: null, since: now - 1000 } });
  await wakeAsk(db, now);
  return readView(db, now);
}
const stallItems = (r) => r.items.filter((i) => i.phase === "stall");
const run = (view, d, now) => dispatchRun(view, { dir: d, roster: ROSTER, lead: LEAD, now });

test("the row helpers: a plain role and a reason make a row that reads back; anything else makes none", () => {
  const row = agentStallRow({ card_id: "card-a", role: "Checker", reason: "#C1 waits at Checker 15 min, Checker idle since 12:00 pm MT" });
  assert.deepEqual(row, { card_id: `${AGENT_STALL}card-a`, reason: "Checker|#C1 waits at Checker 15 min, Checker idle since 12:00 pm MT" });
  assert.deepEqual(agentStallOf({ ...row, created_at: 5 }), { card_id: "card-a", role: "Checker", reason: "#C1 waits at Checker 15 min, Checker idle since 12:00 pm MT", at: 5 });
  for (const bad of [null, {}, { card_id: "c", role: "x|y", reason: "r" }, { card_id: "c", role: "", reason: "r" }, { card_id: "c", role: "Checker" }]) assert.equal(agentStallRow(bad), null);
  assert.equal(agentStallOf({ card_id: "card-a", reason: "Checker|r" }), null, "not an agent-stall row");
  assert.equal(agentStallOf({ card_id: `${AGENT_STALL}c`, reason: "no bar" }), null);
});

test("the store keeps a current idle-agent stall as a taken row with its first time; Manager's inbox still gets the stall once, and the row goes when the stall is over", async () => {
  const db = await world();
  assert.deepEqual((await step(db, T + 14 * MIN)).agentStalls, [], "14 min is no stall yet");
  const v = await step(db, T + 15 * MIN);
  assert.equal(v.agentStalls.length, 1);
  assert.deepEqual({ card_id: v.agentStalls[0].card_id, role: v.agentStalls[0].role, at: v.agentStalls[0].at }, { card_id: "card-a", role: "Checker", at: T + 15 * MIN });
  assert.equal((await step(db, T + 40 * MIN)).agentStalls[0].at, T + 15 * MIN, "the time is when it was first raised, not the latest minute");
  const inbox = await takeInbox(db, T + 41 * MIN);
  assert.deepEqual(inbox.stalls.map((s) => s.card_id), ["card-a"], "Manager's inbox holds the stall, and not the agent-stall row");
  const over = await step(db, T + 42 * MIN, { checker: { state: "working", tool: "Bash", card: "card-a", since: T + 42 * MIN } });
  assert.deepEqual(over.agentStalls, [], "an agent works the card: the stall is over and its row is gone");
});

test("a stall under 30 minutes old wakes nobody; at 30 minutes the stalled role gets a DISPATCH line for the card, and the lead never does", async () => {
  const db = await world();
  const d = dir();
  await step(db, T + 15 * MIN);
  const young = await step(db, T + 44 * MIN);
  assert.deepEqual(stallItems(run(young, d, T + 44 * MIN)), [], "29 minutes old");
  assert.deepEqual(agentStallCards(young, T + 44 * MIN, LEAD), []);
  const old = await step(db, T + 45 * MIN);
  const items = stallItems(run(old, d, T + 45 * MIN));
  assert.equal(items.length, 1);
  assert.equal(items[0].role, "Checker");
  assert.equal(items[0].num, 1);
  assert.match(dispatchLine(items[0]), /^DISPATCH #C1 at stall: it has waited for you 30 minutes while you were idle; read it on the board and pick it up now \(Checker's turn;/);
  assert.equal(STALL_WAKE_AFTER_MS, 30 * MIN);
  // The lead as the stalled role: its own wake is Manager's inbox, never a dispatch line.
  const lead = { cards: [{ id: "card-a", num: 1 }], agentStalls: [{ card_id: "card-a", role: "Manager", reason: "r", at: T }] };
  assert.deepEqual(agentStallCards(lead, T + 60 * MIN, LEAD), []);
});

test("once per stall: the watch that printed the line is not given it again while the stall lasts; a changed reason is a new line", async () => {
  const db = await world();
  const d = dir();
  await step(db, T + 15 * MIN);
  const v1 = await step(db, T + 45 * MIN);
  const r1 = run(v1, d, T + 45 * MIN);
  const asked = { items: r1.items };
  const first = dispatchPending(asked, null, { role: "Checker", level: 1 }).filter((i) => i.phase === "stall");
  assert.equal(first.length, 1);
  const seen = dispatchSeen(null, first);
  const r2 = run(await step(db, T + 60 * MIN), d, T + 60 * MIN);
  assert.deepEqual(dispatchPending({ items: r2.items }, seen, { role: "Checker", level: 1 }).filter((i) => i.phase === "stall"), [], "the same stall, the same card, already printed");
  // The agent works, then goes idle again later: the reason (idle since) is new, the line is new once it is 30 minutes old.
  await step(db, T + 70 * MIN, { checker: { state: "working", tool: "Bash", card: "x", since: T + 70 * MIN } });
  const idle2 = { state: "idle", tool: null, card: null, since: T + 80 * MIN };
  await step(db, T + 95 * MIN, { checker: idle2 });
  const r3 = run(await step(db, T + 125 * MIN, { checker: idle2 }), d, T + 125 * MIN);
  const again = dispatchPending({ items: r3.items }, seen, { role: "Checker", level: 1 }).filter((i) => i.phase === "stall");
  assert.equal(again.length, 1, "a new reason fires again");
  assert.notEqual(again[0].card, first[0].card);
});

test("a role with no open session cannot be woken: its stall is Manager's alone, and no dispatch line is made for an agent that is not idle", async () => {
  const db = await world();
  const d = dir();
  await step(db, T + 15 * MIN);
  const v = await step(db, T + 45 * MIN);
  const busy = { ...v, evidence: { ...v.evidence, agents: { ...v.evidence.agents, value: { ...v.evidence.agents.value, Checker: { state: "working", tool: "Bash", card: "x", since: T + 44 * MIN } } } } };
  assert.deepEqual(stallItems(run(busy, d, T + 45 * MIN)), [], "a working agent is not woken");
});
