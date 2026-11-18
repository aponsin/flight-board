// #C1206 (11-17: the owner chose a Decision in thread #T2043, whose id is t-1794984971436, and the board still refused the card with card-changes-definition): from_thread
// is a thread's number, and a thread the owner opened has an id of its own and its number in threads.num. The number now finds it there, as it finds an ask or a t<num> thread.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard } from "../worker/board-store.mjs";

const T = 1_800_000_000_000;
const OPTS = { needSummary: true, needGroup: true, needRepo: true, needContract: true };
const make = (db, f) => createCard(db, T, "Manager", { title: "A card", summary: "Build it, because it is needed.", batch: "g-test", repo: "flight-board", contract: "DATA.md Started", changes_definition: true, ...f }, OPTS);
const refusedAs = (r, rule) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.refused?.rule, rule, JSON.stringify(r)); };
const thread = async (db, id, num, withMessage = true) => {
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, NULL, ?)").bind(id, num, T).run();
  if (withMessage) await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, 'owner', 'Chose A', ?)").bind(`m-${id}`, id, T).run();
};

test("a thread the owner opened (id t-<ms>) is found by its number for changes_definition true", async () => {
  const db = makeDb();
  await thread(db, "t-1794984971436", 2043);
  const ok = await make(db, { id: "c-by-number", from_thread: 2043 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await db.prepare("SELECT changes_definition AS d FROM cards WHERE id = 'c-by-number'").first()).d, 1);
});

test("a number no thread has, a thread row with no message, and a number that is not a whole positive one are still refused", async () => {
  const db = makeDb();
  await thread(db, "t-1794984971436", 2043);
  await thread(db, "t-1794984971999", 2044, false);
  for (const [i, from_thread] of [2045, 2044, 0, -2043, 2043.5, "2043"].entries()) refusedAs(await make(db, { id: `c-no-${i}`, from_thread }), "card-changes-definition");
});

test("a thread's number is not another thread's id: t2043 as a message thread and the threads row both still work, and a row with a null number finds nothing", async () => {
  const db = makeDb();
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m-old', 't777', 'owner', 'yes', ?)").bind(T).run();
  assert.equal((await make(db, { id: "c-old", from_thread: 777 })).ok, true);
  await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES ('t-1', NULL, 'renamed', ?)").bind(T).run();
  await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES ('m-1', 't-1', 'owner', 'x', ?)").bind(T).run();
  refusedAs(await make(db, { id: "c-null", from_thread: 1 }), "card-changes-definition");
});

test("the same number explains a card with no summary (from_thread alone), as an ask's number does", async () => {
  const db = makeDb();
  await thread(db, "t-1794984971436", 2043);
  const ok = await createCard(db, T, "Manager", { id: "c-nosummary", title: "A card", batch: "g-test", repo: "flight-board", contract: "touches no definition", changes_definition: false, from_thread: 2043 }, OPTS);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  refusedAs(await createCard(db, T, "Manager", { id: "c-nosummary2", title: "A card", batch: "g-test", repo: "flight-board", contract: "x", changes_definition: false, from_thread: 2046 }, OPTS), "card-summary");
});
