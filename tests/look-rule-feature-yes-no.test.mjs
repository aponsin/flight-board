// #C1254 (the owner on #T2106, 11-19): Manager's "add a copy-and-open button for Google Voice texts?" held the look word "button", so lookRefusal wanted a
// picture per option and refused both the Decision and the thread post; the owner got a plain ask with no buttons. An option that starts Yes or No as a
// word answers a yes/no and needs no picture. Still refused: a real look choice between two looks, and any Decision on a visual lane's card.
import test from "node:test";
import assert from "node:assert/strict";
import { createAsk, createCard, writeEvidence, askFromTool } from "../worker/board-store.mjs";
import { lookRefusal, messageExtrasRefusal } from "../worker/board-rules.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_800_000_000_000;
const RED = "redredredredred01", BLUE = "blueblueblueblue02";
const T2106 = { type: "Decision", title: "Add a copy-and-open button for Google Voice texts?", asked_by: "Manager", question: "Add a copy-and-open button for Google Voice texts?", options: ["Yes, add the button", "No, leave it"], recommended: "Yes, add the button" };
const band = (extra = {}) => ({ type: "Decision", title: "Which band?", asked_by: "Manager", question: "A: blue band or B: green band?", options: ["A: blue band", "B: green band"], recommended: "A: blue band", ...extra });
async function seeded({ lanes } = {}) {
  const db = makeDb();
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-100', 900, 'Look', ?)").bind(NOW - 1000).run();
  for (const id of [RED, BLUE]) await db.prepare("INSERT INTO files (id, name, type, size, sha256, added_by, added_at) VALUES (?, ?, 'image/png', 10, '', 'Manager', ?)").bind(id, `${id}.png`, NOW).run();
  for (const [id, owner] of [["design-card", "Designer"], ["code-card", "Boardsmith"]]) assert.equal((await createCard(db, NOW, "Manager", { id, title: id, owner_role: owner })).ok, true);
  if (lanes) assert.equal((await writeEvidence(db, NOW, "probe", "look", { visualLanes: lanes })).ok, true);
  return db;
}

test("lookRefusal: a Yes or No option needs no picture, as a whole word; the look words in the text do not change that", () => {
  const texts = [T2106.title, T2106.question];
  const opt = (...labels) => labels.map((label, i) => ({ key: "ABCD"[i], label }));
  assert.equal(lookRefusal({ texts, options: opt("Yes, add the button", "No, leave it"), shots: [] }), null, "the #T2106 options as asked");
  assert.equal(lookRefusal({ texts, options: opt("Yes", "No"), shots: [] }), null);
  assert.equal(lookRefusal({ texts, options: opt("yes - add it", "NO. leave it", "Something else", "Not now"), shots: [] }), null, "case, a dash or a full stop after the word");
  // Not Yes or No as a word: the option still needs its picture.
  assert.match(lookRefusal({ texts, options: opt("Yesterday's blue band", "Nothing but the band"), shots: [] })?.detail, /missing: A, B\)/);
  assert.match(lookRefusal({ texts, options: opt("Yes2", "No_band"), shots: [] })?.detail, /missing: A, B\)/);
  assert.match(lookRefusal({ texts, options: opt("Blue band", "Green band"), shots: [] })?.detail, /missing: A, B\)/, "a real look choice");
  // A mixed set: only the option that is not a yes/no is named.
  assert.match(lookRefusal({ texts, options: opt("Yes, add the button", "Use the blue band"), shots: [] })?.detail, /missing: B\)/);
});

test("a feature yes/no that names a look word reaches the owner with its buttons: an ask and a decision posted in a thread", async () => {
  const db = await seeded();
  const ask = await createAsk(db, NOW, T2106);
  assert.equal(ask.ok, true, JSON.stringify(ask));
  const posted = await askFromTool(db, NOW, "Manager", { ...T2106, related_thread: "t-100" });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(posted.posted_in_thread, true);
  const opts = [{ key: "A", label: "Yes, add the button" }, { key: "B", label: "No, leave it" }];
  assert.equal(messageExtrasRefusal({ body: T2106.question, kind: "decision", options: opts }, "Manager"), null, "the post path itself");
});

test("must still refuse: a real look choice between two looks with no pictures; with a picture per option it passes", async () => {
  const db = await seeded();
  const bad = await createAsk(db, NOW, band());
  assert.equal(bad.ok, false);
  assert.equal(bad.refused.rule, "look-needs-screenshots");
  assert.match(bad.refused.detail, /missing: A, B\)/);
  const viaThread = await askFromTool(db, NOW, "Manager", band({ related_thread: "t-100" }));
  assert.equal(viaThread.refused?.rule, "look-needs-screenshots", "the thread post too");
  const ok = await createAsk(db, NOW, band({ screenshots: [`${RED} A: blue band`, `${BLUE} B: green band`] }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("must still refuse: any Decision on a visual lane's card with no pictures, a Yes/No one too; a card outside the lanes is not held", async () => {
  const db = await seeded({ lanes: ["Designer"] });
  const bad = await createAsk(db, NOW, { ...T2106, card_id: "design-card" });
  assert.equal(bad.ok, false, "a yes/no on a lane card is still a look decision");
  assert.equal(bad.refused.rule, "look-needs-screenshots");
  assert.match(bad.refused.detail, /missing: A, B\)/);
  const viaThread = await askFromTool(db, NOW, "Manager", { ...T2106, card_id: "design-card", related_thread: "code-card" });
  assert.equal(viaThread.refused?.rule, "look-needs-screenshots");
  const ok = await createAsk(db, NOW, { ...T2106, card_id: "design-card", screenshots: [`${RED} A: with the button`, `${BLUE} B: without`] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const outside = await createAsk(db, NOW, { ...T2106, card_id: "code-card" });
  assert.equal(outside.ok, true, "a card of another role: the words alone decide, and a yes/no needs no picture");
  assert.equal(lookRefusal({ texts: ["Which order?"], options: [{ key: "A", label: "Yes" }, { key: "B", label: "No" }], shots: [], lane: true })?.rule, "look-needs-screenshots", "the pure rule with lane");
});
