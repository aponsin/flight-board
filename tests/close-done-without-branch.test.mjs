// #C902 (prevention, 2026-11-10: #C884's result was a file with no branch; the store kept reading it "at build" and waking Designer, and
// the only close was dropped, which says "not done"). card_update { done: true, done_evidence } closes such a card as done.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, postMessage, readView, recordBuildStart, queueCards, moveInQueue, takeInbox, wakeAsk } from "../worker/board-store.mjs";
import { cardWriteRefusal, stalledWaits, heldWakes, dependsNotLive } from "../worker/board-rules.mjs";
import { initiativeDoc } from "../worker/compat-view.mjs";
import { dispatchInput } from "../collector/store-dispatch.mjs";
import { mirrorCard } from "../collector/store-cards.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000;
const card = async (db, id, extra = {}) => { const r = await createCard(db, T, "Manager", { id, title: id, owner_role: "Designer", ...extra }); assert.equal(r.ok, true, JSON.stringify(r)); };
const row = (db, id) => db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();

test("done with evidence closes the card: done_at and done_evidence are kept, and the view says done", async () => {
  const db = makeDb(); await card(db, "review");
  for (const [id, ev] of [["review", "~/Documents/Team/review-c884.md"]]) {
    const r = await updateCard(db, T + 5, "Designer", { id, done: true, done_evidence: ev });
    assert.equal(r.ok, true, JSON.stringify(r));
    const c = await row(db, id);
    assert.equal(c.done_at, T + 5); assert.equal(c.done_evidence, ev);
    const doc = initiativeDoc(c, null);
    assert.equal(doc.status, "done"); assert.equal(doc.doneAt, T + 5); assert.equal(doc.doneEvidence, ev);
  }
});

test("Still allowed: an absolute path, an https link and a thread message on the board are each evidence", async () => {
  const db = makeDb(); await card(db, "a"); await card(db, "b"); await card(db, "c");
  const m = await postMessage(db, T + 1, "owner", { thread_id: "c", body: "Looks good" });
  assert.equal(m.ok, true, JSON.stringify(m));
  for (const [id, ev] of [["a", "/tmp/out/report.md"], ["b", "https://example.com/report"], ["c", m.id]]) {
    assert.equal((await updateCard(db, T + 2, "Designer", { id, done: true, done_evidence: ev })).ok, true, ev);
  }
});

test("done without evidence, with a bad one, or a message the board does not have, is refused and the card stays open", async () => {
  const db = makeDb(); await card(db, "x");
  for (const [fields, rule] of [
    [{ done: true }, "done-needs-evidence"],
    [{ done: true, done_evidence: "" }, "done-needs-evidence"],
    [{ done: true, done_evidence: "it is finished" }, "done-needs-evidence"],
    [{ done: true, done_evidence: "http://example.com/x" }, "done-needs-evidence"],
    [{ done: true, done_evidence: "m-1800000000000-deadbeef" }, "done-needs-evidence"],
    [{ done: false, done_evidence: "/tmp/x" }, "card-done"],
    [{ done_evidence: "/tmp/x" }, "card-done"],
    [{ done: true, done_evidence: "/tmp/x", dropped: true }, "card-done"],
  ]) {
    const r = await updateCard(db, T + 3, "Designer", { id: "x", ...fields });
    assert.equal(r.ok, false, JSON.stringify(fields)); assert.equal(r.refused.rule, rule, JSON.stringify(fields));
  }
  assert.equal((await row(db, "x")).done_at, null);
});

test("a done card is not closed twice, a dropped card is not made done, and a new card cannot start done", async () => {
  const db = makeDb(); await card(db, "d"); await card(db, "gone");
  assert.equal((await updateCard(db, T + 1, "Designer", { id: "d", done: true, done_evidence: "/tmp/a" })).ok, true);
  assert.equal((await updateCard(db, T + 2, "Designer", { id: "d", done: true, done_evidence: "/tmp/b" })).refused.rule, "card-done");
  assert.equal((await row(db, "d")).done_evidence, "/tmp/a", "the first evidence stays");
  assert.equal((await updateCard(db, T + 1, "Manager", { id: "gone", dropped: true })).ok, true);
  assert.equal((await updateCard(db, T + 2, "Designer", { id: "gone", done: true, done_evidence: "/tmp/a" })).refused.rule, "card-done");
  const n = await createCard(db, T, "Manager", { id: "born-done", title: "t", done: true, done_evidence: "/tmp/a" });
  assert.equal(n.ok, false); assert.equal(n.refused.rule, "card-done");
});

test("the probe stops dispatching a done card", async () => {
  const db = makeDb(); await card(db, "review"); await card(db, "next");
  assert.equal((await updateCard(db, T + 1, "Designer", { id: "review", done: true, done_evidence: "/tmp/r.md" })).ok, true);
  const view = await readView(db, T + 2);
  const now = T + 10_000;
  const input = dispatchInput({ ...view, evidence: { ...(view.evidence ?? {}), agents: { value: { Designer: { state: "idle", since: T } }, readAt: now } } }, now);
  assert.ok(input, "the view can say who is idle");
  const ids = input.cards.map((c) => c.id);
  assert.ok(!ids.includes("review"), "the done card is not dispatched");
  assert.ok(ids.includes("next"), "Still allowed: the open card still is");
  const cards = view.cards;
  assert.equal(cards.find((c) => c.id === "review").done_at, T + 1);
});

test("the pure rule: done_evidence alone, or done false, is refused before the store is asked", () => {
  assert.equal(cardWriteRefusal({ id: "x", done_evidence: "/tmp/a" }, null).rule, "card-done");
  assert.equal(cardWriteRefusal({ id: "x", done: true, done_evidence: "/tmp/a" }, null), null);
});

// ---- Checker F1 on e7490195: every place that skips a closed card skips a done one; each test fails with its check removed. ----
const MIN = 60_000, DONE = { done_at: T + 1, done_evidence: "/tmp/r.md" };
const idle = (now) => ({ Designer: { state: "idle", since: now - 20 * MIN } });

test("F1 stalledWaits: a done card at a phase never wakes Manager as stalled (the bug this card prevents)", () => {
  const now = T + 60 * MIN;
  const run = (extra) => stalledWaits({ now, cards: [{ id: "s", num: 1, owner_role: "Designer", updated_at: now, ...extra }], evidence: { s: { lit: ["build"] } }, agents: idle(now), openAskCards: new Set(), phaseStart: new Map([["s|build", now - 30 * MIN]]) });
  assert.equal(run({}).length, 1, "control: the open card is a stall");
  assert.deepEqual(run(DONE), []);
});

test("F1 heldWakes: a done card's hold wakes nobody", () => {
  const now = T + 5 * 3_600_000;
  const run = (extra) => heldWakes({ now, cards: [{ id: "h", num: 2, waiting_on: "keys", held_at: T, updated_at: T, ...extra }], endsPassed: new Set() });
  assert.equal(run({}).length, 1, "control: held 2 h with no end wakes Manager");
  assert.deepEqual(run(DONE), []);
});

test("F1 dependsNotLive: a done card holds nothing that depends on it", () => {
  const a = { id: "a", depends_on: ["b"] };
  assert.equal(dependsNotLive(a, [a, { id: "b" }], {}), true, "control: an open dependency holds");
  assert.equal(dependsNotLive(a, [a, { id: "b", ...DONE }], {}), false);
});

test("F1 dispatch: a card that depends on a done card is dispatched", async () => {
  const run = async (closeB) => {
    const db = makeDb(); await card(db, "b"); await card(db, "a", { depends_on: ["b"] });
    if (closeB) assert.equal((await updateCard(db, T + 1, "Designer", { id: "b", done: true, done_evidence: "/tmp/b.md" })).ok, true);
    const view = await readView(db, T + 2), now = T + 10_000;
    return dispatchInput({ ...view, evidence: { ...(view.evidence ?? {}), agents: { value: { Designer: { state: "idle", since: T } }, readAt: now } } }, now).cards.map((c) => c.id);
  };
  assert.ok(!(await run(false)).includes("a"), "control: a waits for an open b");
  assert.ok((await run(true)).includes("a"));
});

test("F1 holdEndUnknown: a hold cannot end on a done card", async () => {
  const db = makeDb(); await card(db, "x"); await card(db, "open"); await card(db, "closed");
  assert.equal((await updateCard(db, T + 1, "Designer", { id: "closed", done: true, done_evidence: "/tmp/c.md" })).ok, true);
  assert.equal((await updateCard(db, T + 2, "Manager", { id: "x", blocked_reason: "r", next_note: "n", hold_end: "open" })).ok, true, "control: an open card is an end");
  const r = await updateCard(db, T + 3, "Manager", { id: "x", blocked_reason: "r", next_note: "n", hold_end: "closed" });
  assert.equal(r.ok, false); assert.equal(r.refused.rule, "hold-end-unknown");
});

test("F1 syncStalls: a hold whose end card is closed as done has passed, and wakes Manager", async () => {
  const run = async (close) => {
    const db = makeDb(); await card(db, "x"); await card(db, "end");
    assert.equal((await updateCard(db, T + 1, "Manager", { id: "x", blocked_reason: "waits for end", next_note: "n", hold_end: "end" })).ok, true);
    if (close) assert.equal((await updateCard(db, T + 2, "Designer", { id: "end", done: true, done_evidence: "/tmp/e.md" })).ok, true);
    await wakeAsk(db, T + 3); // the wake runs the stall sync, as in holds-need-an-end
    return (await takeInbox(db, T + 3)).stalls.map((s) => s.reason).filter((r) => /its end has passed/.test(r));
  };
  assert.deepEqual(await run(false), [], "control: the end card is open");
  assert.equal((await run(true)).length, 1);
});

test("F1 recordBuildStart, queueCards and moveInQueue leave a done card out", async () => {
  const db = makeDb(); await card(db, "d"); await card(db, "o");
  assert.ok((await queueCards(db, "Designer")).some((r) => r.id === "d"), "control: in the queue while open");
  assert.equal((await updateCard(db, T + 1, "Designer", { id: "d", done: true, done_evidence: "/tmp/d.md" })).ok, true);
  assert.deepEqual(await recordBuildStart(db, T + 2, "d"), { ok: true, recorded: false, why: "done" });
  const q = (await queueCards(db, "Designer")).map((r) => r.id);
  assert.ok(!q.includes("d")); assert.ok(q.includes("o"));
  const m = await moveInQueue(db, T + 3, "owner", { id: "d", dir: "up" });
  assert.equal(m.ok, false); assert.equal(m.refused.rule, "card-unknown");
});

test("F2 the probe's mirror reads a done card as done (dropped still wins)", () => {
  assert.equal(mirrorCard({ id: "m", ...DONE }).status, "done");
  assert.equal(mirrorCard({ id: "m", dropped: 1, ...DONE }).status, "dropped");
  assert.equal(mirrorCard({ id: "m" }).status, "active");
});

test("F3 the page's thread line says Done for a card closed with evidence, Live for one that shipped", () => {
  const line = (c) => {
    const b = loadNames(["cardLine", "withLine", "liveSubstep", "stepMedians"]);
    Object.assign(b.state, { steps: [], derived: [], waiting: [], messages: [], threads: [], initRaw: [c], initiatives: [c] });
    return b.cardLine("t-1", T).replace(/<[^>]+>/g, "");
  };
  const base = { id: "card-a", num: 410, name: "n", status: "done", thread: "t-1", who: "Designer" };
  assert.equal(line({ ...base, doneEvidence: "/tmp/r.md" }), "→ #C410 · Done");
  assert.equal(line(base), "→ #C410 · Live");
});
