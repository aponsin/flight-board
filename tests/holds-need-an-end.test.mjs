// holds-need-an-end (#C838, prevention for #T1761): a hold (waiting_on or blocked_reason) carries an end the store can check; a held card past its
// end, or held with no end for 2 h, wakes Manager once; the page shows "Held: <reason>, until <end>"; a card waiting for the install names its ask.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { loadBoard, readingDoc, setReadings } from "./harness.mjs";
import { createCard, updateCard, createAsk, wakeAsk, takeInbox, writeEvidence, readView } from "../worker/board-store.mjs";
import { holdEndRefusal, heldWakes } from "../worker/board-rules.mjs";
import { derivedDoc, initiativeDoc } from "../worker/compat-view.mjs";

const T = 1_800_000_000_000, H = 3_600_000, DAY = 86_400_000;
const card = async (db, id, extra = {}) => { const r = await createCard(db, T, "Manager", { id, title: id.toUpperCase(), ...extra }); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const ask = async (db, card_id) => { const r = await createAsk(db, T, { type: "Action", title: "Run the pair", asked_by: "Manager", card_id, steps: ["one"], expect: "ok" }); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const row = (db, id) => db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
const pending = async (db, now) => (await takeInbox(db, now)).stalls.map((s) => s.reason);

// ---- (a) the write needs an end ----
test("(a) a blocked_reason with no end is refused in the same call; the card is unchanged and the refusal is logged", async () => {
  const db = makeDb(); await card(db, "a");
  const b = await updateCard(db, T + 2, "Boardsmith", { id: "a", blocked_reason: "waiting for keys", next_note: "ask for keys" });
  assert.equal(b.ok, false); assert.equal(b.refused.rule, "hold-needs-end");
  assert.equal((await row(db, "a")).blocked_reason, null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'hold-needs-end'").first()).n, 1);
  assert.equal((await updateCard(db, T + 3, "Boardsmith", { id: "a", blocked_reason: "keys", next_note: "n", waiting_on: "x" })).refused.rule, "hold-needs-end", "a waiting_on beside it does not give it an end");
});

test("(a) a routine waiting_on with no end is not refused: the store gives it an end of now + 2 h (hold_until), and an explicit end wins", async () => {
  const db = makeDb(); await card(db, "a"); await card(db, "b");
  const r = await updateCard(db, T + 1, "Boardsmith", { id: "a", waiting_on: "Checker" });
  assert.equal(r.ok, true);
  assert.equal((await row(db, "a")).hold_until, T + 1 + 2 * H); assert.equal((await row(db, "a")).held_at, T + 1);
  await updateCard(db, T + 30 * 60_000, "Boardsmith", { id: "a", waiting_on: "Security" });
  assert.equal((await row(db, "a")).hold_until, T + 30 * 60_000 + 2 * H, "each such write renews it");
  assert.equal((await row(db, "a")).held_at, T + 1, "the hold began when it was first set");
  await updateCard(db, T + 2, "Manager", { id: "b", waiting_on: "owner", check_at: T + DAY });
  assert.equal((await row(db, "b")).hold_until, null, "an explicit end means the store gives none");
  await updateCard(db, T + 40 * 60_000, "Manager", { id: "a", waiting_on: null });
  assert.equal((await row(db, "a")).hold_until, null); assert.equal((await row(db, "a")).held_at, null);
});

test("(a) an end is check_at (the lead's) or hold_end (an open ask or a live card); either lets the hold in and held_at is stamped", async () => {
  const db = makeDb(); await card(db, "a"); await card(db, "b"); await card(db, "dep");
  const t = await ask(db, "b");
  assert.equal((await updateCard(db, T + 1, "Manager", { id: "a", waiting_on: "the owner", check_at: T + DAY })).ok, true);
  assert.equal((await updateCard(db, T + 2, "Boardsmith", { id: "b", waiting_on: "the deploy", hold_end: t.id })).ok, true);
  assert.equal((await updateCard(db, T + 3, "Boardsmith", { id: "dep", blocked_reason: "needs b", next_note: "after b", hold_end: "b" })).ok, true);
  assert.equal((await row(db, "a")).held_at, T + 1);
  assert.equal((await row(db, "b")).hold_end, t.id);
  assert.equal((await row(db, "b")).held_at, T + 2);
});

test("(a) an agent cannot give a hold the lead-only check date; a hold_end naming nothing, a closed ask or a dropped card is refused; the shape is checked", async () => {
  const db = makeDb(); await card(db, "a"); await card(db, "gone", { dropped: true }); const t = await ask(db, "a");
  assert.equal((await updateCard(db, T + 1, "Boardsmith", { id: "a", waiting_on: "x", check_at: T + DAY })).refused.rule, "check-at-lead-only");
  assert.equal((await updateCard(db, T + 2, "Boardsmith", { id: "a", waiting_on: "x", hold_end: "nothing-here" })).refused.rule, "hold-end-unknown");
  assert.equal((await updateCard(db, T + 3, "Boardsmith", { id: "a", waiting_on: "x", hold_end: "gone" })).refused.rule, "hold-end-unknown");
  await db.prepare("UPDATE asks SET closed_at = ? WHERE id = ?").bind(T, t.id).run();
  assert.equal((await updateCard(db, T + 4, "Boardsmith", { id: "a", waiting_on: "x", hold_end: t.id })).refused.rule, "hold-end-unknown");
  assert.equal((await updateCard(db, T + 5, "Boardsmith", { id: "a", waiting_on: "x", hold_end: "Not An Id" })).refused.rule, "hold-end-shape");
});

test("(a) a card created blocked needs the end in the same call; created waiting it gets the store's", async () => {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "n1", title: "N", blocked_reason: "keys", next_note: "n" })).refused.rule, "hold-needs-end");
  assert.equal((await createCard(db, T, "Manager", { id: "n2", title: "N", blocked_reason: "keys", next_note: "n", check_at: T + DAY })).ok, true);
  assert.equal((await createCard(db, T, "Manager", { id: "n3", title: "N", waiting_on: "owner" })).ok, true);
  assert.equal((await row(db, "n3")).hold_until, T + 2 * H);
});

test("(a) lifting a hold needs no end and clears the end; an existing end carries over; a write that sets no hold is never refused for an old hold with none", async () => {
  const db = makeDb(); await card(db, "a"); await card(db, "old");
  await updateCard(db, T + 1, "Manager", { id: "a", waiting_on: "owner", check_at: T + DAY });
  assert.equal((await updateCard(db, T + 2, "Boardsmith", { id: "a", blocked_reason: "keys", next_note: "n" })).ok, true, "the check date already on the card is its end");
  await updateCard(db, T + 3, "Manager", { id: "a", waiting_on: null, blocked_reason: null, hold_end: null, next_note: "lifted" });
  assert.equal((await row(db, "a")).held_at, null);
  // an old hold written before the rule (no end) still takes title edits
  await db.prepare("UPDATE cards SET waiting_on = 'legacy' WHERE id = 'old'").run();
  assert.equal((await updateCard(db, T + 4, "Boardsmith", { id: "old", title: "Renamed" })).ok, true);
  assert.equal(holdEndRefusal({ title: "x" }, { waiting_on: "legacy" }), null);
});

// ---- (b) a passed end wakes Manager once ----
// #C1104: a hold whose end has passed ends by itself (no "lift or renew" line to Manager); the words it held go to hold_history.
const history = async (db, id) => (await db.prepare("SELECT waiting_on, blocked_reason, hold_end FROM hold_history WHERE card_id = ? ORDER BY id").bind(id).all()).results;
const noHold = (r) => r.waiting_on === null && r.blocked_reason === null && r.hold_end === null && r.held_at === null && r.hold_until === null;

test("(b) a held card whose check date has passed has its hold ended by the store: no line to Manager, the check date goes, the words are kept in hold_history", async () => {
  const db = makeDb(); await card(db, "late");
  await updateCard(db, T, "Manager", { id: "late", waiting_on: "the owner's deploy", check_at: T + H });
  await wakeAsk(db, T + 30 * 60_000);
  assert.deepEqual(await pending(db, T + 30 * 60_000), [], "not before the end");
  assert.equal((await row(db, "late")).waiting_on, "the owner's deploy", "the hold stands until its end");
  await wakeAsk(db, T + 2 * H);
  assert.deepEqual(await pending(db, T + 2 * H), [], "no lift-or-renew line");
  const r = await row(db, "late");
  assert.ok(noHold(r), JSON.stringify(r)); assert.equal(r.check_at, null);
  assert.deepEqual(await history(db, "late"), [{ waiting_on: "the owner's deploy", blocked_reason: null, hold_end: null }]);
  await wakeAsk(db, T + 3 * H);
  assert.deepEqual(await pending(db, T + 3 * H), [], "nothing later either");
  assert.equal((await history(db, "late")).length, 1, "ended once");
});

test("(b) a hold whose ask is closed, or whose card is dropped or live, has passed its end; no end of its own lifts it, Manager is told (#C1104: only a check date or the store's 2 h ends a hold)", async () => {
  const db = makeDb(); await card(db, "h1"); await card(db, "h2"); await card(db, "dep");
  const t = await ask(db, "h1");
  // Answered, not closed: the hold's end is still open, and #C904's 10-minute ask line (not this test's subject) stays out.
  await db.prepare("UPDATE asks SET answered_at = ?, answer_taken_at = ? WHERE id = ?").bind(T, T, t.id).run();
  await updateCard(db, T, "Boardsmith", { id: "h1", waiting_on: "owner", hold_end: t.id });
  await updateCard(db, T, "Boardsmith", { id: "h2", waiting_on: "dep", hold_end: "dep" });
  await wakeAsk(db, T + H);
  assert.deepEqual(await pending(db, T + H), [], "both ends still open");
  await db.prepare("UPDATE asks SET closed_at = ? WHERE id = ?").bind(T + H, t.id).run();
  await writeEvidence(db, T + H, "probe", "cards.dep", { lit: ["live"], phase: "live" });
  await wakeAsk(db, T + H + 1000);
  const got = await pending(db, T + H + 1000);
  assert.equal(got.length, 2); assert.ok(got.every((s) => /its end has passed: lift or renew \(end [a-z0-9-]+\)$/.test(s)));
  for (const id of ["h1", "h2"]) { assert.equal((await history(db, id)).length, 0, `${id}: the store lifted nothing`); assert.ok((await row(db, id)).waiting_on); }
});

test("(b) a hold renewed after it ended is a new hold, and it ends by itself when ITS end passes (Checker F1, as #C1104)", async () => {
  const db = makeDb(); await card(db, "again");
  await updateCard(db, T, "Boardsmith", { id: "again", waiting_on: "Checker" });
  await wakeAsk(db, T + 2 * H); assert.deepEqual(await pending(db, T + 2 * H), []); assert.ok(noHold(await row(db, "again")));
  await updateCard(db, T + 2 * H, "Boardsmith", { id: "again", waiting_on: "Checker" }); // renewed, same words: a new end at T + 4 h
  await wakeAsk(db, T + 3 * H); assert.equal((await row(db, "again")).waiting_on, "Checker", "the new hold stands until its own end");
  await wakeAsk(db, T + 4 * H); assert.deepEqual(await pending(db, T + 4 * H), []); assert.ok(noHold(await row(db, "again")), "the second end ends it again");
  await updateCard(db, T + 4 * H, "Manager", { id: "again", blocked_reason: "keys", next_note: "n", check_at: T + 5 * H });
  await wakeAsk(db, T + 6 * H);
  const r = await row(db, "again"); assert.ok(noHold(r)); assert.equal(r.check_at, null);
  assert.deepEqual((await history(db, "again")).map((h) => h.waiting_on ?? h.blocked_reason), ["Checker", "Checker", "keys"]);
  await updateCard(db, T + 6 * H, "Manager", { id: "again", blocked_reason: "keys again", next_note: "n", check_at: T + 8 * H });
  await wakeAsk(db, T + 7 * H); assert.equal((await row(db, "again")).blocked_reason, "keys again", "a check date still to come is no end: the hold stands");
});

test("(b) a card dropped is an end (Checker F2): Manager is told, the store does not lift the hold (#C1104)", async () => {
  const db = makeDb(); await card(db, "h"); await card(db, "dep");
  await updateCard(db, T, "Boardsmith", { id: "h", waiting_on: "dep", hold_end: "dep" });
  await wakeAsk(db, T + H); assert.deepEqual(await pending(db, T + H), []);
  await db.prepare("UPDATE cards SET dropped = 1 WHERE id = 'dep'").run();
  await wakeAsk(db, T + H + 1000);
  assert.equal((await pending(db, T + H + 1000)).length, 1);
  assert.equal((await row(db, "h")).waiting_on, "dep");
});

test("(b) an OPEN hold_end holds even when a check date has passed: the G17 group holds do not lapse (#C1104, Manager)", async () => {
  const db = makeDb(); await card(db, "grp"); await card(db, "dep");
  await updateCard(db, T, "Manager", { id: "grp", waiting_on: "land job", hold_end: "dep", check_at: T + H });
  await wakeAsk(db, T + 2 * H);
  const r = await row(db, "grp");
  assert.equal(r.waiting_on, "land job"); assert.equal(r.hold_end, "dep"); assert.equal(r.check_at, T + H);
  assert.equal((await history(db, "grp")).length, 0);
  await db.prepare("UPDATE cards SET dropped = 1 WHERE id = 'dep'").run(); // its end has come, and so has the check date: now it ends
  await wakeAsk(db, T + 3 * H);
  assert.ok(noHold(await row(db, "grp")));
  assert.deepEqual(await history(db, "grp"), [{ waiting_on: "land job", blocked_reason: null, hold_end: "dep" }]);
});

test("(a) stripping a blocked card's only end is refused; stripping a waiting_on's explicit end is not (the store gives 2 h)", async () => {
  const db = makeDb(); await card(db, "b"); await card(db, "w");
  await updateCard(db, T, "Manager", { id: "b", blocked_reason: "keys", next_note: "n", check_at: T + DAY });
  assert.equal((await updateCard(db, T + 1, "Manager", { id: "b", check_at: null })).refused.rule, "hold-needs-end");
  assert.equal((await updateCard(db, T + 2, "Manager", { id: "b", title: "Renamed" })).ok, true, "a write touching none of the three is fine");
  assert.equal((await updateCard(db, T + 3, "Manager", { id: "b", blocked_reason: null, next_note: "free", check_at: null })).ok, true, "lifting the block lifts the end");
  await updateCard(db, T + 4, "Manager", { id: "w", waiting_on: "owner", check_at: T + DAY });
  assert.equal((await updateCard(db, T + 5, "Manager", { id: "w", check_at: null })).ok, true);
});

// ---- (c) no end for 2 h ----
test("(b) the end the store gave a routine waiting_on ends the hold when it passes; a renewed write moves it", async () => {
  const db = makeDb(); await card(db, "r");
  await updateCard(db, T, "Boardsmith", { id: "r", waiting_on: "Checker" });
  await wakeAsk(db, T + 2 * H - 1000);
  assert.deepEqual(await pending(db, T + 2 * H - 1000), []); assert.equal((await row(db, "r")).waiting_on, "Checker");
  await updateCard(db, T + H, "Boardsmith", { id: "r", waiting_on: "Security" }); // renewed to T + 3 h
  await wakeAsk(db, T + 2 * H + 1000);
  assert.deepEqual(await pending(db, T + 2 * H + 1000), []); assert.equal((await row(db, "r")).waiting_on, "Security", "the renewed end has not come");
  await wakeAsk(db, T + 3 * H);
  assert.deepEqual(await pending(db, T + 3 * H), [], "no line to Manager");
  assert.ok(noHold(await row(db, "r")));
  assert.deepEqual(await history(db, "r"), [{ waiting_on: "Security", blocked_reason: null, hold_end: null }]);
  await wakeAsk(db, T + 9 * H);
  assert.deepEqual(await pending(db, T + 9 * H), []);
});

test("(c) a hold that already has no end wakes Manager once after 2 h (counted from the card's last change when held_at is unknown)", async () => {
  const db = makeDb(); await card(db, "legacy");
  await db.prepare("UPDATE cards SET waiting_on = 'someone', updated_at = ? WHERE id = 'legacy'").bind(T).run();
  await wakeAsk(db, T + 2 * H - 1000);
  assert.deepEqual(await pending(db, T + 2 * H - 1000), []);
  await wakeAsk(db, T + 2 * H);
  const num = (await row(db, "legacy")).num;
  assert.deepEqual(await pending(db, T + 2 * H), [`#C${num} held on someone, no end set after 2 h: lift it or give it an end (held since Jan 15 1:00 am MT)`]);
  await wakeAsk(db, T + 5 * H);
  assert.deepEqual(await pending(db, T + 5 * H), [], "once");
});

test("heldWakes is pure: a dropped card, a card with no hold and a card with a future end never wake", () => {
  const base = { num: 1, waiting_on: "x", updated_at: T - 9 * H };
  const cards = [{ ...base, id: "dropped", dropped: 1 }, { id: "free", num: 2, updated_at: T - 9 * H }, { ...base, id: "future", check_at: T + H }];
  assert.deepEqual(heldWakes({ now: T, cards, endsPassed: new Set() }), []);
});

// ---- (d) the page ----
test("(d) the page shows 'Held: <reason>, until <end>' for a check date, an ask, and no end", () => {
  const b = loadBoard();
  const draw = (f) => { b.state.steps = []; b.state.waiting = []; return b.initRow(b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", ...f }))); };
  // #C935: the reason stays in view, the end sits inside the card's Details fold as "Until: <end>".
  assert.match(draw({ waitingOn: "the deploy", holdEnd: "t1763" }), /Held: the deploy<[\s\S]*Until: t1763/);
  assert.match(draw({ waitingOn: "the owner", checkAt: Date.now() + DAY }), /Held: the owner<[\s\S]*Until: (?!no end)/);
  assert.match(draw({ waitingOn: "someone" }), /Held: someone<[\s\S]*Until: no end set/);
  assert.match(draw({ waitingOn: "Checker", holdUntil: Date.now() + 2 * H }), /Held: Checker<[\s\S]*Until: (?!no end)/);
  assert.match(draw({ blocked: "keys", status: "blocked" }), /Held: keys<[\s\S]*Until: no end set/);
});

test("(d) the compat view carries holdEnd and heldAt", async () => {
  const db = makeDb(); await card(db, "a"); const t = await ask(db, "a");
  await updateCard(db, T + 1, "Boardsmith", { id: "a", waiting_on: "owner", hold_end: t.id });
  const doc = initiativeDoc(await row(db, "a"), null);
  assert.equal(doc.holdEnd, t.id); assert.equal(doc.heldAt, T + 1);
  await updateCard(db, T + 2, "Boardsmith", { id: "a", waiting_on: "Checker", hold_end: null });
  assert.equal(initiativeDoc(await row(db, "a"), null).holdUntil, T + 2 + 2 * H);
});

// ---- (e) the install wait names its ask ----
test("(e) a board-repo card on main and not deployed names its open ask, or the page says 'no deploy ask yet'", async () => {
  const db = makeDb(); await card(db, "r1", { repo: "board" }); await card(db, "r2", { repo: "board" });
  const t = await ask(db, "r1");
  for (const id of ["r1", "r2"]) await writeEvidence(db, T, "probe", `cards.${id}`, { lit: ["ship"], phase: "ship", onMain: true });
  const d = derivedDoc(await readView(db, T + 1000)).cards;
  assert.equal(d.r1.wait, "install"); assert.equal(d.r1.waitAsk, t.num); assert.equal(d.r2.waitAsk, undefined);
  // #C1382: the row no longer draws the install wait's ask from the evidence (derived.waitAsk): it draws the reading. The install wait is the green stripes tile and the pill 'Waiting for install';
  // a wait for the release of a product card (the draw here has no repo word, so it is a product card) is the yellow 'Queued for Release's ship'.
  const b = loadBoard(), old = Date.now() - 5 * H;
  const draw = (id, reading) => { b.state.steps = []; b.state.waiting = []; setReadings(b, readingDoc(id, reading)); return b.initRow(b.gates(b.enrich({ id, level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", nextNote: "x", nextNoteAt: old, createdAt: old, etaLive: Date.now() + 1 }))); };
  const inst = draw("r1", { phase: "install", state: "waiting", wait: "install", with: null });
  assert.match(inst, /<span class="state queued">Waiting for install<\/span>/);
  assert.doesNotMatch(inst, /Waiting for install: /, "the page no longer builds the ask's words from the evidence");
  assert.match(draw("r2", { phase: "ship", state: "waiting", wait: "deploy", with: null }), /Queued for Release(?:'|&#39;)s ship/);
});
