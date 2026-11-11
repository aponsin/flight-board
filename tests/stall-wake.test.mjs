// #C732 (the owner's pick A on #T1681): on the new store a card that waits 15 min at ANY phase while that phase's agent is idle (and no CI run is
// going) wakes Manager once with the reason, and again only when the reason changes. Gated (an open ask), Blocked, Paused and Dropped
// cards are exempt, each with a test. The wake is the store's "anything for Manager?" answer; the reason is read through read_inbox.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { stalledWaits, STALL_AFTER_MS } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const hhmm = (ms) => `${new Date(ms).toISOString().slice(11, 16)}Z`;

// A card at `phase` since T (its phase_history start), with the phase's agent idle since `idleSince`.
async function world({ phase = "checker", role = "Checker", idleSince = T, ci = "none", owner = "Boardsmith", card = "card-a" } = {}) {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: card, title: "A card", owner_role: owner });
  await writeEvidence(db, T, "probe", `cards.${card}`, { lit: [phase], phase, ci });
  await writeEvidence(db, T, "probe", "agents", { [role]: { state: "idle", tool: null, card: null, since: idleSince } });
  return db;
}
const agents = (db, now, roster) => writeEvidence(db, now, "probe", "agents", roster);
const pending = async (db, now) => (await wakeAsk(db, now)).count;

test("a card waiting 15 min at a phase with its agent idle wakes Manager once, with the reason; not before", async () => {
  const db = await world();
  assert.equal(await pending(db, T + 15 * MIN - 1), 0, "14 min 59 s is not yet");
  const r = await wakeAsk(db, T + 15 * MIN);
  assert.equal(r.count, 1); assert.equal(r.send, true); assert.match(r.line, /^1 for Manager, batch b-\d+$/);
  assert.doesNotMatch(r.line, /waits at/, "the line carries a count, never the reason");
  const got = await takeInbox(db, T + 15 * MIN + 1000);
  assert.deepEqual(got.stalls.map((s) => s.reason), [`#C1 waits at Checker 15 min, Checker idle since ${hhmm(T)}`]);
  assert.equal(got.stalls[0].num, 1);
});

test("sent once per reason: after Manager read it, the same stall does not wake again, however long it lasts", async () => {
  const db = await world();
  await takeInbox(db, T); // nothing yet
  assert.equal(await pending(db, T + 20 * MIN), 1);
  assert.equal((await takeInbox(db, T + 21 * MIN)).stalls.length, 1);
  for (const m of [22, 40, 120, 600]) assert.equal(await pending(db, T + m * MIN), 0, `still quiet at ${m} min`);
  assert.deepEqual((await takeInbox(db, T + 700 * MIN)).stalls, []);
});

test("again when the reason changes: the agent worked and went idle again, or the card moved to another phase", async () => {
  const db = await world();
  assert.equal(await pending(db, T + 20 * MIN), 1);
  await takeInbox(db, T + 21 * MIN);
  // Checker works on something else, then idles again at T+30 min: the card has waited since then.
  await agents(db, T + 25 * MIN, { Checker: { state: "working", tool: "Bash", card: "other", since: T + 25 * MIN } });
  await agents(db, T + 30 * MIN, { Checker: { state: "idle", tool: null, card: null, since: T + 30 * MIN } });
  assert.equal(await pending(db, T + 44 * MIN), 0, "the wait counts from the later idle time");
  assert.equal(await pending(db, T + 45 * MIN), 1);
  assert.match((await takeInbox(db, T + 46 * MIN)).stalls[0].reason, new RegExp(`idle since ${hhmm(T + 30 * MIN)}$`));
  // The card moves on to Security, whose agent has been idle: a new reason.
  await writeEvidence(db, T + 50 * MIN, "probe", "cards.card-a", { lit: ["security"], phase: "security", ci: "none" });
  await agents(db, T + 50 * MIN, { Security: { state: "idle", tool: null, card: null, since: T + 50 * MIN } });
  assert.equal(await pending(db, T + 66 * MIN), 1);
  assert.match((await takeInbox(db, T + 67 * MIN)).stalls[0].reason, /waits at Security 15 min, Security idle since/);
});

test("a stall that is over before Manager reads it is no longer pending, and an older untaken reason is replaced by the new one", async () => {
  const db = await world();
  assert.equal(await pending(db, T + 20 * MIN), 1);
  await agents(db, T + 21 * MIN, { Checker: { state: "working", tool: "Bash", card: "card-a", since: T + 21 * MIN } });
  assert.equal(await pending(db, T + 22 * MIN), 0, "an agent now works the card");
  assert.deepEqual((await takeInbox(db, T + 23 * MIN)).stalls, []);
  const db2 = await world();
  assert.equal(await pending(db2, T + 20 * MIN), 1);
  await agents(db2, T + 21 * MIN, { Checker: { state: "idle", tool: null, card: null, since: T + 21 * MIN } });
  assert.equal(await pending(db2, T + 37 * MIN), 1, "one pending, not two");
  const got = await takeInbox(db2, T + 38 * MIN);
  assert.equal(got.stalls.length, 1); assert.match(got.stalls[0].reason, new RegExp(`idle since ${hhmm(T + 21 * MIN)}$`));
});

test("every phase is covered: the phase's lane agent, or the card's owner for a phase with no lane", async () => {
  const lanes = { language: "Linguist", design: "Designer", checker: "Checker", security: "Security", ship: "Release", pack: "Release", install: "Release" };
  for (const phase of ["plan", "build", "test", "language", "design", "checker", "security", "ship", "pack", "install", "review", "approve", "merge"]) {
    const role = lanes[phase] ?? "Boardsmith";
    const db = await world({ phase, role });
    assert.equal(await pending(db, T + 15 * MIN), 1, phase);
    assert.match((await takeInbox(db, T + 16 * MIN)).stalls[0].reason, new RegExp(`^#C1 waits at ${phase[0].toUpperCase()}${phase.slice(1)} 15 min, ${role} idle since `), phase);
  }
});

// The exemptions: each one alone keeps a stall that would otherwise fire from firing.
const exempt = (name, fix) => test(`exempt: ${name}`, async () => {
  const db = await world();
  await fix(db);
  assert.equal(await pending(db, T + 60 * MIN), 0);
  assert.deepEqual((await takeInbox(db, T + 61 * MIN)).stalls, []);
});
exempt("Gated: an open ask on the card", (db) => db.prepare("INSERT INTO asks (id, num, type, title, asked_by, card_id, body, created_at) VALUES ('t1', 1, 'Answer', 'q', 'Manager', 'card-a', '{}', ?)").bind(T).run());
exempt("Blocked: the card has a blocked reason", (db) => db.prepare("UPDATE cards SET blocked_reason = 'waiting for a key' WHERE id = 'card-a'").run());
exempt("Paused", (db) => db.prepare("UPDATE cards SET paused = 1 WHERE id = 'card-a'").run());
exempt("Dropped", (db) => db.prepare("UPDATE cards SET dropped = 1 WHERE id = 'card-a'").run());
exempt("waiting on someone (waiting_on)", (db) => db.prepare("UPDATE cards SET waiting_on = 'the owner' WHERE id = 'card-a'").run());
exempt("a CI run is going", (db) => writeEvidence(db, T + 1000, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "running" }));
exempt("a CI run is queued", (db) => writeEvidence(db, T + 1000, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "queued" }));
exempt("a ship run is on now", (db) => writeEvidence(db, T + 1000, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none", shipping: true }));
exempt("the card is live", (db) => writeEvidence(db, T + 1000, "probe", "cards.card-a", { lit: ["live"], phase: "live", ci: "none" }));
exempt("the phase's agent is busy on another card", (db) => agents(db, T + 1000, { Checker: { state: "working", tool: "Bash", card: "other", since: T } }));
exempt("an agent works the card (not its lane's)", (db) => agents(db, T + 1000, { Checker: { state: "idle", tool: null, card: null, since: T }, Builder: { state: "working", tool: "Bash", card: "card-a", since: T } }));

test("exempt: a phase with no lane and a card with no owner has no agent to wait on", async () => {
  const db = await world({ phase: "build", role: "Boardsmith", owner: null });
  assert.equal(await pending(db, T + 60 * MIN), 0);
});

test("the wait counts from the agent going idle: a card queued for an hour behind a busy agent does not wake the minute it frees", async () => {
  const db = await world({ idleSince: T + 59 * MIN });
  assert.equal(await pending(db, T + 60 * MIN), 0);
  assert.equal(await pending(db, T + 74 * MIN - 1000), 0);
  assert.equal(await pending(db, T + 74 * MIN), 1);
});

test("stalledWaits: an unusable roster, an unknown phase or a role that is not a plain name gives nothing", () => {
  const card = { id: "c", num: 5, owner_role: "Boardsmith" };
  const base = { now: T + STALL_AFTER_MS * 2, cards: [card], evidence: { c: { lit: ["build"] } }, openAskCards: new Set(), phaseStart: new Map([["c|build", T]]) };
  assert.equal(stalledWaits({ ...base, agents: { Boardsmith: { state: "idle", since: T } } }).length, 1);
  assert.equal(stalledWaits({ ...base, agents: null }).length, 0);
  assert.equal(stalledWaits({ ...base, agents: { Boardsmith: { state: "idle", since: "soon" } } }).length, 0);
  assert.equal(stalledWaits({ ...base, evidence: { c: { lit: ["nonsense"] } }, agents: { Boardsmith: { state: "idle", since: T } } }).length, 0);
  assert.equal(stalledWaits({ ...base, cards: [{ ...card, owner_role: "x\ny" }], agents: { "x\ny": { state: "idle", since: T } } }).length, 0);
  assert.equal(stalledWaits({ ...base, cards: [{ ...card, num: null }], agents: { Boardsmith: { state: "idle", since: T } } }).length, 0);
});

// #C828: a phase agent with no open session is a stall, "no session", counted from the phase's start.
test("#C828 a phase agent with no open session: the card waiting 15 min at its phase wakes Manager once with 'no session'; not before", async () => {
  const db = await world();
  await agents(db, T + 1000, { Someone: { state: "idle", tool: null, card: null, since: T } }); // Checker is not listed: no session
  assert.equal(await pending(db, T + 15 * MIN - 1), 0, "14 min 59 s is not yet");
  const r = await wakeAsk(db, T + 15 * MIN);
  assert.equal(r.count, 1); assert.equal(r.send, true);
  assert.deepEqual((await takeInbox(db, T + 15 * MIN + 1000)).stalls.map((s) => s.reason), ["#C1 waits at Checker 15 min, no session for Checker"]);
  for (const m of [16, 60, 600]) assert.equal(await pending(db, T + m * MIN), 0, `sent once, quiet at ${m} min`);
});

test("#C828 the session comes back: the stall is over, and an idle agent after that is the old reason", async () => {
  const db = await world();
  await agents(db, T + 1000, { Someone: { state: "idle", tool: null, card: null, since: T } });
  assert.equal(await pending(db, T + 20 * MIN), 1);
  await agents(db, T + 21 * MIN, { Someone: { state: "idle", tool: null, card: null, since: T }, Checker: { state: "working", tool: "Bash", card: "card-a", since: T + 21 * MIN } });
  assert.equal(await pending(db, T + 22 * MIN), 0, "the agent is back and works the card");
  assert.deepEqual((await takeInbox(db, T + 23 * MIN)).stalls, []);
});

test("#C828 an empty or missing agents reading is a blind probe, never a stall; the exemptions still hold with no session", async () => {
  const blind = await world();
  await agents(blind, T + 1000, {});
  assert.equal(await pending(blind, T + 60 * MIN), 0, "an empty reading says nobody is absent");
  const none = makeDb();
  await createCard(none, T, "Manager", { id: "card-a", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(none, T, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none" });
  assert.equal(await pending(none, T + 60 * MIN), 0, "no agents reading at all");
  for (const [name, fix] of [
    ["Gated", (db) => db.prepare("INSERT INTO asks (id, num, type, title, asked_by, card_id, body, created_at) VALUES ('t1', 1, 'Answer', 'q', 'Manager', 'card-a', '{}', ?)").bind(T).run()],
    ["Blocked", (db) => db.prepare("UPDATE cards SET blocked_reason = 'waiting for a key' WHERE id = 'card-a'").run()],
    ["Paused", (db) => db.prepare("UPDATE cards SET paused = 1 WHERE id = 'card-a'").run()],
    ["a CI run is going", (db) => writeEvidence(db, T + 1000, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "running" })],
    ["live", (db) => writeEvidence(db, T + 1000, "probe", "cards.card-a", { lit: ["live"], phase: "live", ci: "none" })],
  ]) {
    const db = await world();
    await agents(db, T + 1000, { Someone: { state: "idle", tool: null, card: null, since: T } });
    await fix(db);
    assert.equal(await pending(db, T + 60 * MIN), 0, name);
  }
});

test("#C828 stalledWaits: no session needs the phase's start; a lane agent that is working or idle-but-young is not 'no session'", () => {
  const card = { id: "c", num: 5, owner_role: "Boardsmith" };
  const base = { now: T + STALL_AFTER_MS * 2, cards: [card], evidence: { c: { lit: ["checker"] } }, openAskCards: new Set(), phaseStart: new Map([["c|checker", T]]) };
  const someone = { Someone: { state: "idle", since: T } };
  assert.deepEqual(stalledWaits({ ...base, agents: someone }).map((s) => s.reason), ["#C5 waits at Checker 15 min, no session for Checker"]);
  assert.equal(stalledWaits({ ...base, agents: someone, phaseStart: new Map() }).length, 0, "no phase start: nothing to count from");
  assert.equal(stalledWaits({ ...base, agents: someone, now: T + STALL_AFTER_MS - 1 }).length, 0);
  assert.equal(stalledWaits({ ...base, agents: { ...someone, Checker: { state: "working", card: "x", since: T } } }).length, 0);
  assert.equal(stalledWaits({ ...base, agents: { ...someone, Checker: { state: "idle", since: T + STALL_AFTER_MS * 2 - 1000 } } }).length, 0, "listed and idle: the idle rule, not 'no session'");
});

// #C846: a card with nothing pushed (no lit phase) whose owner has been idle 15 min wakes Manager once: "#Cn: nothing pushed, <Role> idle since hh:mm".
test("#C846 stalledWaits: a queued card with an idle owner is a stall; the exemptions and the owner's other cards", () => {
  const D = 24 * 3600e3, now = T + STALL_AFTER_MS, idle = { Boardsmith: { state: "idle", since: T } };
  const card = (o = {}) => ({ id: "c", num: 6, owner_role: "Boardsmith", updated_at: T, ...o });
  const run = (o = {}, w = {}) => stalledWaits({ now, cards: [card(o.card)], evidence: {}, agents: idle, openAskCards: new Set(), phaseStart: new Map(), ...w });
  assert.deepEqual(run().map((s) => s.reason), [`Boardsmith idle since ${hhmm(T)}, 1 queued, next #C6`]);
  assert.equal(run({}, { now: T + STALL_AFTER_MS - 1 }).length, 0, "14 min 59 s is not yet");
  assert.equal(run({}, { agents: { Boardsmith: { state: "working", card: "x", since: T } } }).length, 0, "an owner who is working");
  assert.equal(run({}, { agents: { Boardsmith: { state: "idle", since: T + 60e3 } } }).length, 0, "idle under 15 min");
  assert.equal(run({}, { agents: {} }).length, 0, "no reading of the owner");
  for (const [name, o] of [["paused", { paused: 1 }], ["dropped", { dropped: 1 }], ["blocked", { blocked_reason: "waiting for DNS" }], ["held on someone", { waiting_on: "Security: a verdict" }], ["the lead's", { owner_role: "Manager" }], ["an old card", { updated_at: T - 4 * D }], ["no number", { num: null }]]) {
    const w = o.owner_role === "Manager" ? { agents: { Manager: { state: "idle", since: T } } } : {};
    assert.equal(run({ card: o }, w).length, 0, name);
  }
  assert.equal(run({}, { openAskCards: new Set(["c"]) }).length, 0, "an open ask");
  // behind a depends_on that is not live: no stall; once it is live, or gone, or dropped, it is
  const dep = { id: "dep", num: 5, owner_role: "Builder", updated_at: T };
  const behind = { cards: [card({ depends_on: '["dep"]' }), dep] };
  const forC = (w) => run({}, w).filter((s) => s.card_id === "c").length;
  assert.equal(forC({ ...behind, evidence: { dep: { lit: ["checker"] } } }), 0, "dependency at checker");
  assert.equal(forC({ ...behind, evidence: { dep: { lit: ["live"] } } }), 1, "dependency live");
  assert.equal(forC({ cards: [card({ depends_on: '["dep"]' }), { ...dep, dropped: 1 }] }), 1, "dependency dropped");
  assert.equal(forC({ cards: [card({ depends_on: '["ghost"]' })] }), 1, "dependency the board does not have");
  // the owner's other cards do not matter: one at review (its phase agent working) and the rest queued still wake
  const two = stalledWaits({ now, cards: [card({ id: "r", num: 7 }), card({ id: "q", num: 8 })], evidence: { r: { lit: ["checker"] } }, agents: { ...idle, Checker: { state: "working", card: "r", since: T } }, openAskCards: new Set(), phaseStart: new Map([["r|checker", T]]) });
  assert.deepEqual(two.map((s) => s.card_id), ["q"]);
});

test("#C846 end to end: a queued card of an idle owner reaches Manager's inbox once", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "card-q", title: "Queued", owner_role: "Boardsmith" });
  await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "idle", tool: null, card: null, since: T } });
  assert.equal(await pending(db, T + 14 * MIN), 0);
  assert.equal(await pending(db, T + 15 * MIN), 1);
  assert.deepEqual((await takeInbox(db, T + 16 * MIN)).stalls.map((s) => s.reason), [`Boardsmith idle since ${hhmm(T)}, 1 queued, next #C1`]);
  assert.equal(await pending(db, T + 60 * MIN), 0, "sent once");
});

// #C846 (Checker): the stored depends_on reaches the rule through syncStalls's own query, so it is tested through the store, not only
// through stalledWaits.
test("#C846 end to end: a queued card behind a dependency that is not live does not wake Manager; once the dependency is live it does", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "card-dep", title: "Dependency", owner_role: "Builder" });
  await createCard(db, T, "Manager", { id: "card-q", title: "Queued", owner_role: "Boardsmith", depends_on: ["card-dep"] });
  await writeEvidence(db, T, "probe", "cards.card-dep", { lit: ["checker"], phase: "checker", ci: "none" });
  // Checker is working on the dependency, so only card-q could be a stall.
  await writeEvidence(db, T, "probe", "agents", { Boardsmith: { state: "idle", tool: null, card: null, since: T }, Checker: { state: "working", tool: null, card: "card-dep", since: T } });
  assert.equal(await pending(db, T + 20 * MIN), 0, "behind a dependency at checker");
  await writeEvidence(db, T + 21 * MIN, "probe", "cards.card-dep", { lit: ["live"], phase: "live", ci: "none" });
  assert.equal(await pending(db, T + 22 * MIN), 1, "the dependency is live");
  assert.deepEqual((await takeInbox(db, T + 23 * MIN)).stalls.map((s) => s.card_id), ["card-q"]);
});
