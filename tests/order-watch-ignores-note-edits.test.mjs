// #C1118 (11-16 ~5:15 pm MT: Manager added review LOWs to #C1113's next_note and the #C1103 line said "#C1113 is being worked while #C865 (g17) waits: stop it"; nobody was
// building #C1113): the agents reading's card is only the last card the session's transcript NAMES, so a role that read a note it did not write looked like it was working that
// card. Only the owner's own work counts as worked: a push on the card's branch, or a step or an ask from the owner role. A note write by Manager or a reviewer is none of these.
// What the guard must still allow (the false-positive list, first): a fresh start pushed out of order, a step the owner logged on a not-yet-pushed card, an ask the owner posted
// on it, and rework / the next card of a started group (not named, as before).
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { outOfOrderWork, orderLine, ORDER_ROW_END, ownWorkOn } from "../worker/board-rules.mjs";
import { createCard, writeEvidence, updateCard, writeStep, createAsk } from "../worker/board-store.mjs";
import { wakeAsk, takeInbox, beat } from "./helpers/beating-store.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const order = [{ batch: "g6", pos: 1 }, { batch: "g13", pos: 2 }];
const rows = [{ id: "hi", num: 1, owner_role: "Boardsmith", batch: "g6" }, { id: "lo", num: 2, owner_role: "Boardsmith", batch: "g13" }];
const hiEv = { lit: ["build"], phase: "build", headSha12: "a".repeat(12) };
const working = { Boardsmith: { state: "working", card: "lo" } };
const go = (evidence, ownWork) => outOfOrderWork({ cards: rows, evidence, agents: working, groupOrder: order, ownWork }).map((s) => s.num);

test("the pure rule: a card nothing of the owner's shows on is not worked; a push, or an owner step or ask (ownWork), is", () => {
  assert.deepEqual(go({ hi: hiEv }), [], "named by the transcript only (Manager edited its note): nobody is building it");
  assert.deepEqual(go({ hi: hiEv }, new Set()), []);
  assert.deepEqual(go({ hi: hiEv }, new Set(["other"])), [], "another card's own work does not count for this one");
  assert.deepEqual(go({ hi: hiEv, lo: { lit: ["build"], phase: "build", headSha12: "b".repeat(12) } }), [2], "a push on the card's branch");
  assert.deepEqual(go({ hi: hiEv, lo: { lit: ["build"], phase: "build", headSha: "b".repeat(40) } }), [2], "a full sha reads the same");
  assert.deepEqual(go({ hi: hiEv }, new Set(["lo"])), [2], "a step or an ask of the owner on a card with nothing pushed");
  assert.equal(ownWorkOn({ id: "lo" }, { lo: { headSha12: "" } }, undefined), false, "an empty sha is no push");
  assert.equal(ownWorkOn({ id: "lo" }, undefined, ["lo"]), false, "ownWork is a Set; anything else counts for nothing");
});

async function world() {
  const db = makeDb();
  for (const [id, group, num] of [["hi", "g6", 11], ["lo", "g13", 12]]) await createCard(db, T, "Manager", { id, title: id, summary: "s", owner_role: "Boardsmith", batch: group });
  await db.prepare("UPDATE cards SET num = 11 WHERE id = 'hi'").run();
  await db.prepare("UPDATE cards SET num = 12 WHERE id = 'lo'").run();
  await db.prepare("INSERT INTO group_order (batch, pos, set_by, set_at) VALUES ('g6', 1, 'owner', 1), ('g13', 2, 'owner', 1)").run();
  await beat(db, T + MIN);
  await writeEvidence(db, T + MIN, "probe", "agents", { Boardsmith: { state: "working", card: "lo", lastActivityAt: T + MIN, since: T } });
  return db;
}
const lines = async (db, at) => (await takeInbox(db, at)).stalls.map((s) => s.reason).filter((r) => r.endsWith(ORDER_ROW_END));
const LINE = orderLine({ num: 12, group: "g13" }, { num: 11, group: "g6" });

test("the store: Manager's note edit on a lower-group card the owner's session only named raises no line; the owner's push does", async () => {
  const db = await world();
  assert.ok((await updateCard(db, T + 2 * MIN, "Manager", { id: "lo", next_note: "review LOWs: tidy the comment, test the edge" })).ok);
  await wakeAsk(db, T + 3 * MIN);
  assert.deepEqual(await lines(db, T + 3 * MIN + 1000), [], "a note edit is no work of the owner's");
  await writeEvidence(db, T + 4 * MIN, "probe", "cards.lo", { lit: ["build"], phase: "build", headSha12: "b".repeat(12), signed: [], onMain: false });
  await wakeAsk(db, T + 5 * MIN);
  assert.deepEqual(await lines(db, T + 5 * MIN + 1000), [LINE], "the owner pushes the lower card's branch while the higher card waits: the line appears");
});

test("the store: a step the owner logged, or an ask the owner posted, on an unpushed card is the owner's work; a step by someone else is not", async () => {
  const stepped = await world();
  assert.equal((await writeStep(stepped, T + 2 * MIN, "Release", { init: "lo", phase: "ship", kind: "start", wait: "busy" })).ok, true);
  await wakeAsk(stepped, T + 3 * MIN);
  assert.deepEqual(await lines(stepped, T + 3 * MIN + 1000), [], "another role's step is no work of the owner's");
  assert.equal((await writeStep(stepped, T + 4 * MIN, "Boardsmith", { init: "lo", phase: "build", kind: "start", wait: "busy" })).ok, true);
  await wakeAsk(stepped, T + 5 * MIN);
  assert.deepEqual(await lines(stepped, T + 5 * MIN + 1000), [LINE], "the owner's own step");
  const asked = await world();
  const a = await createAsk(asked, T + 2 * MIN, { type: "Later", title: "L", asked_by: "Boardsmith", text: "t", eta_at: T + 86_400_000, card_id: "lo" });
  assert.ok(a.id, JSON.stringify(a));
  await wakeAsk(asked, T + 3 * MIN);
  assert.deepEqual(await lines(asked, T + 3 * MIN + 1000), [LINE], "the owner's own ask");
});
