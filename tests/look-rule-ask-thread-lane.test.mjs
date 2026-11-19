// #C1255 (Checker 2's LOW on c36d3415, #C1254): a decision posted into the thread of an ask that sits on a visual lane's card (thread_id = the ask's
// id) kept the Yes/No exemption, because postMessage resolved the lane only when thread_id was a card id. It now reads the ask's card too.
import test from "node:test";
import assert from "node:assert/strict";
import { createAsk, createCard, writeEvidence, postMessage } from "../worker/board-store.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_800_000_000_000;
const RED = "redredredredred01", BLUE = "blueblueblueblue02";
const yesNo = [{ key: "A", label: "Yes, blue band" }, { key: "B", label: "No, keep green" }];
const plain = (extra = {}) => ({ type: "Decision", title: "Which order?", asked_by: "Manager", question: "First the left one or the right one?", options: ["Left", "Right"], recommended: "Left", ...extra });
async function seeded({ lanes } = {}) {
  const db = makeDb();
  for (const id of [RED, BLUE]) await db.prepare("INSERT INTO files (id, name, type, size, sha256, added_by, added_at) VALUES (?, ?, 'image/png', 10, '', 'Manager', ?)").bind(id, `${id}.png`, NOW).run();
  for (const [id, owner] of [["design-card", "Designer"], ["code-card", "Boardsmith"]]) assert.equal((await createCard(db, NOW, "Manager", { id, title: id, owner_role: owner })).ok, true);
  if (lanes) assert.equal((await writeEvidence(db, NOW, "probe", "look", { visualLanes: lanes })).ok, true);
  const pics = [`${RED} A: left`, `${BLUE} B: right`];
  const onDesign = await createAsk(db, NOW, plain({ card_id: "design-card", screenshots: pics }));
  const onCode = await createAsk(db, NOW, plain({ card_id: "code-card" }));
  const noCard = await createAsk(db, NOW, plain());
  for (const a of [onDesign, onCode, noCard]) assert.equal(a.ok, true, JSON.stringify(a));
  return { db, onDesign: onDesign.id, onCode: onCode.id, noCard: noCard.id };
}
const post = (db, thread_id, extra = {}) => postMessage(db, NOW, "Manager", { thread_id, body: "Make the band blue?", kind: "decision", options: yesNo, ...extra });

test("a decision posted into the thread of an ask on a visual lane's card needs pictures, a Yes/No one too", async () => {
  const { db, onDesign } = await seeded({ lanes: ["Designer"] });
  const bad = await post(db, onDesign);
  assert.equal(bad.ok, false, "Checker 2's case: thread_id is the ask id");
  assert.equal(bad.refused.rule, "look-needs-screenshots");
  assert.match(bad.refused.detail, /missing: A, B\)/);
  const ok = await post(db, onDesign, { screenshots: [`${RED} A: blue`, `${BLUE} B: green`] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("an ask on a card outside the lanes, an ask with no card, and an unknown thread keep the exemption; so does a board with no lanes posted", async () => {
  const { db, onCode, noCard } = await seeded({ lanes: ["Designer"] });
  assert.equal((await post(db, onCode)).ok, true, "an ask on a card of another role");
  assert.equal((await post(db, noCard)).ok, true, "an ask with no card");
  assert.equal((await post(db, "some-free-thread")).ok, true, "a thread that is neither a card nor an ask");
  const none = await seeded();
  assert.equal((await post(none.db, none.onDesign)).ok, true, "no look evidence posted yet: the exemption stands");
});

test("the card thread itself is still held (c36d3415), and a post whose words are not about the look reads as before on the ask's thread", async () => {
  const { db, onDesign } = await seeded({ lanes: ["Designer"] });
  assert.equal((await post(db, "design-card")).refused?.rule, "look-needs-screenshots");
  assert.equal((await postMessage(db, NOW, "Manager", { thread_id: onDesign, body: "Friday or Monday?", kind: "decision", options: [{ key: "A", label: "Friday" }, { key: "B", label: "Monday" }] })).ok, true);
});
