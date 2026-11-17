// #C1104: a hold (waiting_on, blocked_reason, hold_end) whose end has passed ends by itself. Pure rule first, then the store.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { endedHolds } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000, H = 3_600_000;
const c = (o = {}) => ({ id: "x", num: 1, waiting_on: "owner", blocked_reason: null, hold_end: null, check_at: null, hold_until: null, dropped: 0, done_at: null, ...o });

test("a hold ends when its check date or the store's own 2 h end has passed, and only then", () => {
  const ids = (cards, ends) => endedHolds({ now: T, cards, endsPassed: new Set(ends ?? []) }).map((h) => h.id);
  assert.deepEqual(ids([c({ id: "a", check_at: T - 1 }), c({ id: "b", check_at: T })]), ["a", "b"], "the end is at or before now");
  assert.deepEqual(ids([c({ id: "a", check_at: T + 1 })]), [], "a date still to come");
  assert.deepEqual(ids([c({ id: "a", hold_until: T - 5 }), c({ id: "b", hold_until: T + 5 })]), ["a"], "the store's own end");
  assert.deepEqual(ids([c({ id: "a", hold_until: T - 5, check_at: T + 9 })]), [], "an explicit end wins over the store's");
  assert.deepEqual(ids([c({ id: "a", blocked_reason: "keys", waiting_on: null, check_at: T - 1 })]), ["a"]);
});

test("Manager's guard: a hold_end never ends a hold by itself, and an open one holds even past a check date", () => {
  const ids = (cards, ends) => endedHolds({ now: T, cards, endsPassed: new Set(ends ?? []) }).map((h) => h.id);
  assert.deepEqual(ids([c({ id: "a", hold_end: "ask-1" })], ["ask-1"]), [], "a closed hold_end with no check date: Manager is told (heldWakes), nothing is lifted");
  assert.deepEqual(ids([c({ id: "a", hold_end: "dep", check_at: T - 1 })], []), [], "an open card or ask holds, with the check date passed");
  assert.deepEqual(ids([c({ id: "a", hold_end: "dep", hold_until: T - 5 })], []), [], "an open hold_end beats the store's 2 h too");
  assert.deepEqual(ids([c({ id: "a", hold_end: "dep", check_at: T - 1 })], ["dep"]), ["a"], "its end closed and the check date passed: it ends");
  assert.deepEqual(ids([c({ id: "a", hold_end: "dep", hold_until: T - 5 })], ["dep"]), [], "a closed hold_end with only the store's end: not lifted");
});

test("a card with no end, no hold, or already dropped or done is left alone", () => {
  const got = endedHolds({ now: T, cards: [c({ id: "noend" }), c({ id: "nohold", waiting_on: null, check_at: T - 1 }), c({ id: "dropped", check_at: T - 1, dropped: 1 }), c({ id: "done", check_at: T - 1, done_at: T - 9 }), c({ id: "nonum", num: null, check_at: T - 1 }), null], endsPassed: new Set() });
  assert.deepEqual(got, []);
});

test("it says what the hold held, and whether the date that ended it goes too", () => {
  const [h] = endedHolds({ now: T, cards: [c({ id: "a", waiting_on: "Checker", check_at: T - 1, hold_end: "e1", hold_until: T - 9 })], endsPassed: new Set(["e1"]) });
  assert.deepEqual(h, { id: "a", num: 1, waiting_on: "Checker", blocked_reason: null, hold_end: "e1", check_at: T - 1, hold_until: T - 9, clearCheckAt: true });
  assert.deepEqual(endedHolds({ now: T, cards: [c({ id: "b", hold_end: "e1", check_at: T + 5 })], endsPassed: new Set(["e1"]) }), [], "a check date still to come ends nothing and stays: it is somebody's wish to look again");
  assert.equal(h.clearCheckAt, true);
});

test("the store leaves a hold alone that was rewritten after it was read (the update names the hold it read)", async () => {
  const db = makeDb();
  const made = await createCard(db, T, "Manager", { id: "race", title: "RACE" }); assert.equal(made.ok, true);
  await updateCard(db, T, "Manager", { id: "race", waiting_on: "old words", check_at: T + H });
  const real = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = real(sql);
    if (!sql.startsWith("UPDATE cards SET waiting_on = NULL")) return st;
    return { bind: (...a) => { const b = st.bind(...a); return { run: async () => { await real("UPDATE cards SET waiting_on = 'new words' WHERE id = 'race'").run(); return b.run(); } }; } };
  };
  await wakeAsk(db, T + 2 * H);
  const row = await db.prepare("SELECT waiting_on FROM cards WHERE id = 'race'").first();
  assert.equal(row.waiting_on, "new words", "the newer write is kept");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM hold_history WHERE card_id = 'race'").first()).n, 0, "nothing was ended, so nothing is logged");
});

test("Checker 2's L1 on e944b23e: renewing only the date (or only the store's end) mid-run keeps the hold", async () => {
  for (const [name, sneaky] of [["check_at", `UPDATE cards SET check_at = ${T + 9 * H} WHERE id = 'race'`], ["hold_until", `UPDATE cards SET hold_until = ${T + 9 * H} WHERE id = 'race'`]]) {
    const db = makeDb();
    await createCard(db, T, "Manager", { id: "race", title: "RACE" });
    if (name === "check_at") await updateCard(db, T, "Manager", { id: "race", waiting_on: "same words", check_at: T + H });
    else { await updateCard(db, T, "Manager", { id: "race", waiting_on: "same words" }); } // the store gives it hold_until = T + 2 h
    const real = db.prepare.bind(db);
    db.prepare = (sql) => {
      const st = real(sql);
      if (!sql.startsWith("UPDATE cards SET waiting_on = NULL")) return st;
      return { bind: (...a) => { const b = st.bind(...a); return { run: async () => { await real(sneaky).run(); return b.run(); } }; } };
    };
    await wakeAsk(db, T + 3 * H);
    const row = await db.prepare("SELECT waiting_on, check_at, hold_until FROM cards WHERE id = 'race'").first();
    assert.equal(row.waiting_on, "same words", `${name}: a renewed end keeps the hold`);
    assert.equal(row[name], T + 9 * H, `${name}: the new date stays`);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM hold_history WHERE card_id = 'race'").first()).n, 0);
  }
});

test("a card closed live or dropped afterwards is untouched by the store's pass, and no line goes to Manager for an ended hold", async () => {
  const db = makeDb();
  await createCard(db, T, "Manager", { id: "gone", title: "GONE" });
  await updateCard(db, T, "Manager", { id: "gone", waiting_on: "owner", check_at: T + H });
  await db.prepare("UPDATE cards SET dropped = 1 WHERE id = 'gone'").run();
  await wakeAsk(db, T + 2 * H);
  const row = await db.prepare("SELECT waiting_on, check_at FROM cards WHERE id = 'gone'").first();
  assert.equal(row.waiting_on, "owner", "a dropped card's hold is not rewritten");
  assert.deepEqual((await takeInbox(db, T + 2 * H)).stalls.map((s) => s.reason), []);
});
