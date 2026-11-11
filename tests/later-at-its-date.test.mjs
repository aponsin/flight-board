// #C879 (DATA.md row 19, audit group F): a Later ask moves to Needs you at its ETA, as a Decision with a not-before does (#C823),
// with no write in between; a Later with no date (a precondition only) stays under Later.
import test from "node:test";
import assert from "node:assert/strict";
import { waitingDoc } from "../worker/compat-view.mjs";
import { createAsk } from "../worker/board-store.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadNames } from "./harness.mjs";

const NOW = 1_794_336_590_090, HOUR = 3_600_000, DAY = 86_400_000;

function board(waiting) {
  const b = loadNames(["renderAll", "youItems", "tabCounts", "isLater"]);
  Object.assign(b.state, { waiting, messages: [], threads: [], initRaw: [], ideas: [], todo: [] });
  return b;
}
const later = (id, eta, extra = {}) => ({ id, kind: "later", text: "Later " + id, since: NOW - 5 * DAY, ...(eta === undefined ? {} : { eta }), ...extra });

test("a Later before its ETA waits on Later; at its ETA and after it is on Needs you; one with no date stays on Later", () => {
  const b = board([later("future", NOW + 2 * DAY), later("due", NOW), later("past", NOW - HOUR), later("nodate", undefined, { etaWhen: "after the install" })]);
  const [future, due, past, nodate] = b.state.waiting;
  assert.equal(b.isLater(future, NOW), true);
  assert.equal(b.isLater(due, NOW), false, "at the ETA itself");
  assert.equal(b.isLater(past, NOW), false);
  assert.equal(b.isLater(nodate, NOW), true, "a precondition the page can't see keeps it on Later");
  assert.deepEqual(b.youItems(NOW, "").asks.map((w) => w.id).sort(), ["due", "past"]);
  const c = b.tabCounts(NOW, "");
  assert.equal(c.later, 2); assert.equal(c.you, 2);
  // The clock alone moves it: the same doc an hour on.
  assert.equal(b.isLater(future, NOW + 2 * DAY + HOUR), false);
});

test("the store's Later carries its eta_at to the page as eta", async () => {
  const db = makeDb();
  const r = await createAsk(db, NOW, { type: "Later", title: "Check the install", asked_by: "Manager", text: "Look at it", eta_at: NOW + DAY });
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = await db.prepare("SELECT * FROM asks").first();
  const doc = waitingDoc(row);
  assert.equal(doc.kind, "later"); assert.equal(doc.eta, NOW + DAY);
  assert.equal(board([doc]).isLater(doc, NOW + DAY), false, "on Needs you at its date");
});
