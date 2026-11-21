// #C1409 (the owner: when an ask is called off "your click should become outdated or something, in red so I don't miss it"; he ran a command from an ask after Manager said "no longer needed"):
// Manager's door calls off a Terminal, Action or Later ask with a reason and an optional replacement (ask_outdate). The ask is NOT closed: it stays in the owner's lists, served with
// `outdated: { at, by, reason, replacedBy? }` and no `done`, and he closes it himself. But it is owed by no one: every reader of "waiting on the owner" skips it (one test per reader, each
// with a control showing an ordinary open ask still counts). His answer to it is kept and wakes Manager with a note.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, createAsk, updateCard, answerAsk, closeAsk, outdateAsk, wakeAsk, takeInbox, readView } from "../worker/board-store.mjs";
import { outdatedRefusal, replacedByNum, isOutdated } from "../worker/board-rules.mjs";
import { waitingDoc } from "../worker/compat-view.mjs";
import { readingInputs } from "../worker/compat-reading.mjs";
import { viewForTool } from "../worker/view-filter.mjs";
import { askWaitsFrom, ownerWordWakes, promiseWakes } from "../worker/push-rules.mjs";
import { pushRun } from "../worker/push-store.mjs";
import { newSecret } from "../scripts/push-keys.mjs";
import { openAsksFile, landHoldsFile, dispatchRun } from "../collector/store-dispatch.mjs";

const T = 1_800_000_000_000, MIN = 60_000;
const SECRET = "s".repeat(43), MSECRET = "m".repeat(43), SESSION = "local_b0c20591-32ff-41db-b0e5-ff9fc3fb26de";
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const terminal = (extra = {}) => ({ type: "Terminal", title: "Clean up the old folders", asked_by: "Manager", commands: ["ls ~/Documents/Code"], ...extra });
const rule = (r) => r?.refused?.rule ?? r?.structuredContent?.refused?.rule;
const row = (db, id) => db.prepare("SELECT * FROM asks WHERE id = ?").bind(id).first();
async function board() {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "c900-thing", title: "Thing", owner_role: "Builder" })).ok, true);
  const mk = async (extra = {}, at = T) => { const r = await createAsk(db, at, terminal({ card_id: "c900-thing", ...extra })); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
  return { db, mk };
}
const callOff = (db, id, reason = "Manager changed the plan", extra = {}, now = T + MIN) => outdateAsk(db, now, "Manager", { id, reason, ...extra });

test("refusals: only Manager, only Terminal, Action or Later, not answered, closed or already outdated, a reason of 1 to 300 characters, a real other replacement; nothing is written", async () => {
  const { db, mk } = await board();
  const a = await mk(), other = await mk(), decision = await createAsk(db, T, { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" });
  const noChange = async (id) => assert.equal((await row(db, id)).outdated_at, null, `${id} untouched`);
  assert.equal(rule(await outdateAsk(db, T + MIN, "Builder", { id: a.id, reason: "x" })), "outdate-manager-only");
  assert.equal(rule(await outdateAsk(db, T + MIN, "owner", { id: a.id, reason: "x" })), "outdate-manager-only");
  assert.equal(rule(await callOff(db, decision.id)), "outdate-type");
  assert.equal(outdatedRefusal({ id: "t9", type: "Approval" }, "Manager", { reason: "x" })?.rule, "outdate-type");
  assert.equal(rule(await callOff(db, "t999")), "ask-unknown");
  assert.equal(rule(await callOff(db, a.id, "")), "outdate-reason");
  assert.equal(rule(await callOff(db, a.id, "   ")), "outdate-reason");
  assert.equal(rule(await callOff(db, a.id, "x".repeat(301))), "outdate-reason");
  assert.equal(rule(await outdateAsk(db, T + MIN, "Manager", { id: a.id })), "outdate-reason");
  assert.equal(rule(await callOff(db, a.id, "ok", { replaced_by: "T9999" })), "outdate-replacement", "an unknown ask");
  assert.equal(rule(await callOff(db, a.id, "ok", { replaced_by: a.num })), "outdate-replacement", "itself");
  assert.equal(rule(await callOff(db, a.id, "ok", { replaced_by: "soon" })), "outdate-replacement", "not a number");
  assert.equal(rule(await callOff(db, a.id, "ok", { replaced_by: 0 })), "outdate-replacement");
  assert.equal(rule(await callOff(db, a.id, "ok", { color: "red" })), "outdate-shape");
  await noChange(a.id);
  await answerAsk(db, T + 2, "owner", { id: other.id, answer: "Done" });
  assert.equal(rule(await callOff(db, other.id)), "outdate-answered");
  const closed = await mk();
  await closeAsk(db, T + 3, "owner", closed.id, "owner");
  assert.equal(rule(await callOff(db, closed.id)), "outdate-closed");
  assert.equal((await callOff(db, a.id)).ok, true);
  assert.equal(rule(await callOff(db, a.id, "again", {}, T + 2 * MIN)), "outdate-already");
  assert.equal((await row(db, a.id)).outdated_reason, "Manager changed the plan", "the second call changed nothing");
  assert.deepEqual([replacedByNum(12), replacedByNum("12"), replacedByNum("T12"), replacedByNum("#T12"), replacedByNum("#t12"), replacedByNum(-1), replacedByNum(1.5), replacedByNum("12x"), replacedByNum(null)], [12, 12, 12, 12, 12, null, null, null, null]);
});

test("the working case: the columns are set, the replacement is stored as its number, and the ask is NOT closed", async () => {
  const { db, mk } = await board();
  const a = await mk({}, T), b = await mk({ title: "The new way" }, T + 1);
  const r = await callOff(db, a.id, "  Manager changed the plan  ", { replaced_by: `#T${b.num}` });
  assert.deepEqual(r, { ok: true, id: a.id, outdated: true, replaced_by: b.num });
  const x = await row(db, a.id);
  assert.equal(x.outdated_at, T + MIN);
  assert.equal(x.outdated_by, "Manager");
  assert.equal(x.outdated_reason, "Manager changed the plan", "trimmed");
  assert.equal(x.replaced_by, b.num);
  assert.equal(x.closed_at, null, "the owner closes it himself");
  assert.equal(x.closed_by, null);
  assert.equal(x.withdrawn_at, null, "withdrawn_at stays the owner's Withdraw of an approval");
  assert.equal(isOutdated(x), true);
  const later = await createAsk(db, T, { type: "Later", title: "Look again", asked_by: "Manager", text: "Look at it", eta_at: T + 60 * MIN, eta_precondition: "after the deploy" });
  assert.equal((await callOff(db, later.id)).ok, true, "a Later is called off too");
  const action = await createAsk(db, T, { type: "Action", title: "Click it", asked_by: "Manager", steps: ["Click Save"], expect: "Saved" });
  assert.equal((await callOff(db, action.id, "no longer needed")).replaced_by, undefined, "no replacement named, none stored");
  assert.equal((await row(db, action.id)).replaced_by, null);
});

test("served: the ask's doc carries outdated exactly as the contract says, and no done: it is not closed", async () => {
  const { db, mk } = await board();
  const a = await mk(), b = await mk();
  await callOff(db, a.id, "Manager changed the plan", { replaced_by: b.num });
  await callOff(db, b.id, "no longer needed");
  const view = await readView(db, T + 2 * MIN);
  const doc = (id) => waitingDoc(view.asks.find((x) => x.id === id));
  assert.deepEqual(doc(a.id).outdated, { at: T + MIN, by: "Manager", reason: "Manager changed the plan", replacedBy: b.num });
  assert.deepEqual(doc(b.id).outdated, { at: T + MIN, by: "Manager", reason: "no longer needed" }, "replacedBy left out when there is none");
  assert.equal(doc(a.id).done, undefined);
  assert.equal(doc(a.id).doneAt, undefined);
  assert.equal(doc(a.id).steps[0].cmd, "ls ~/Documents/Code", "its commands are still served (the page greys them)");
  const plain = await mk();
  assert.equal(waitingDoc((await readView(db, T + 2 * MIN)).asks.find((x) => x.id === plain.id)).outdated, undefined, "an ordinary ask has no outdated");
});

test("it stays in the owner's open list (served, closed_at null) until he closes it; his close is the existing close and moves it to done", async () => {
  const { db, mk } = await board();
  const a = await mk();
  await callOff(db, a.id);
  const view = await readView(db, T + 2 * MIN);
  const served = view.asks.find((x) => x.id === a.id);
  assert.equal(served.closed_at, null);
  assert.equal(served.outdated_at, T + MIN);
  assert.equal(viewForTool(view, { owner_role: "Builder" }).asks.some((x) => x.id === a.id), true, "an agent reading its open asks still sees it, with the mark");
  const r = await closeAsk(db, T + 3 * MIN, "owner", a.id, "owner");
  assert.equal(r.ok, true, JSON.stringify(r));
  const closed = await row(db, a.id);
  assert.equal(closed.closed_at, T + 3 * MIN);
  assert.equal(closed.outdated_reason, "Manager changed the plan", "and the call-off stays on the record");
  const doc = waitingDoc(closed);
  assert.equal(doc.done, true);
  assert.equal(doc.outdated.reason, "Manager changed the plan");
});

test("reader: open-asks.json (the Stop hook's list) leaves it out, and keeps an ordinary open ask", async () => {
  const { db, mk } = await board();
  const a = await mk(), ctl = await mk();
  await callOff(db, a.id);
  const f = openAsksFile(await readView(db, T + 2 * MIN), T + 2 * MIN);
  assert.deepEqual(f.asks, [ctl.num]);
});

test("reader: the card's ask wait (the reading's open asks, and the ends that have passed) skips it, and keeps an ordinary open ask", async () => {
  const { db, mk } = await board();
  const a = await mk(), ctl = await mk({ card_id: "c900-thing" });
  await callOff(db, a.id);
  const { ctx } = readingInputs(await readView(db, T + 2 * MIN));
  assert.deepEqual(ctx.asks.map((x) => x.num), [ctl.num]);
  assert.equal(ctx.endsPassed.has(a.id), true, "a hold that ends on it has ended");
  assert.equal(ctx.endsPassed.has(ctl.id), false);
});

test("reader: the dispatch and the landing holds do not treat the card as asked, and do for an ordinary open ask", async () => {
  const { db, mk } = await board();
  const a = await mk();
  const asksOf = async () => (await db.prepare("SELECT * FROM asks").all()).results;
  const view = (asks) => ({ cards: [{ id: "c900-thing", owner_role: "Builder", waiting_on: null, paused: 0, dropped: 0 }], asks, evidence: { agents: { readAt: T - 1000, value: { Builder: { state: "idle", lastActivityAt: T - 20 * MIN, since: T - 20 * MIN, card: "c900-thing" }, Manager: { state: "idle", lastActivityAt: T - 20 * MIN, since: T - 20 * MIN, card: null } } } } });
  const items = (v) => dispatchRun(v, { dir: mkdtempSync(`${tmpdir()}/od-`), roster: ["Manager", "Builder"], lead: "Manager", now: T }).items;
  assert.deepEqual(items(view(await asksOf())), [], "control: an ordinary open ask holds the card");
  assert.equal(landHoldsFile(view(await asksOf()), T).cards["c900-thing"], "asked", "control");
  await callOff(db, a.id);
  assert.deepEqual(items(view(await asksOf())).map((i) => i.card), ["c900-thing"], "called off: the card is Builder's again");
  assert.equal(landHoldsFile(view(await asksOf()), T).cards["c900-thing"], "", "and nothing holds its landing");
});

test("reader: no stall line to Manager (\"ask has waited for the owner\") for it, and one for an ordinary ask (control)", async () => {
  const { db, mk } = await board();
  const a = await mk(), ctl = await mk();
  await callOff(db, a.id);
  await wakeAsk(db, T + 40 * MIN);
  const said = (await takeInbox(db, T + 41 * MIN)).stalls.map((s) => s.reason).filter((r) => /has waited/.test(r));
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0], new RegExp(`ask #T${ctl.num} has waited`));
});

test("reader: an idle agent's queue line (the card waits to be built) counts a card whose only ask is called off, and not one with an ordinary open ask (control)", async () => {
  const { db, mk } = await board();
  await createCard(db, T, "Manager", { id: "c901-other", title: "Other", owner_role: "Builder" });
  const a = await mk(), ctl = await mk({ card_id: "c901-other" });
  await db.prepare("INSERT INTO evidence (key, value, read_at) VALUES ('agents', ?, ?)").bind(JSON.stringify({ Builder: { state: "idle", tool: null, card: null, since: T } }), T + 19 * MIN).run();
  const queued = async (now) => { await wakeAsk(db, now); return (await takeInbox(db, now + 1)).stalls.map((s) => s.reason).filter((r) => /queued/.test(r)); };
  const before = await queued(T + 20 * MIN);
  assert.equal(before.length, 0, `control: both cards are asked, so nothing is queued: ${JSON.stringify(before)}`);
  await callOff(db, a.id);
  const after = await queued(T + 21 * MIN);
  assert.equal(after.length, 1, JSON.stringify(after));
  assert.match(after[0], /1 queued/, "only the card whose ask was called off");
});

test("reader: no phone push for it, and one for an ordinary ask (control)", async () => {
  const { db, mk } = await board();
  const a = await mk(), ctl = await mk();
  await callOff(db, a.id);
  await pushRun(db, T + 40 * MIN, { PUSH_VAPID_JWK: await newSecret("https://board.example.invalid") }, async () => assert.fail("no device, no fetch"));
  const marked = (await db.prepare("SELECT ref FROM push_sent WHERE kind = 'ask'").all()).results.map((r) => r.ref);
  assert.deepEqual(marked, [ctl.id]);
});

test("reader: the push rules themselves (the wait of an ask, a promise's date, the owner's last word on its thread) skip it", () => {
  const ask = (over = {}) => ({ id: "a1", num: 7, type: "Action", eta_at: null, created_at: T, answered_at: null, closed_at: null, withdrawn_at: null, outdated_at: null, ...over });
  assert.equal(askWaitsFrom(ask()), T, "control");
  assert.equal(askWaitsFrom(ask({ outdated_at: T + 1 })), null);
  const promise = (over = {}) => ask({ type: "Later", owed_by: "Manager", eta_at: T - 1, ...over });
  assert.equal(promiseWakes({ asks: [promise()], now: T }).length, 1, "control");
  assert.equal(promiseWakes({ asks: [promise({ outdated_at: T })], now: T }).length, 0);
  const word = (over = {}) => ({ thread_id: "t7", at: T, body: "why is this red?", prev_team_body: "", ask_num: 7, ...over });
  assert.equal(ownerWordWakes({ rows: [word()], now: T + 60 * MIN }).length, 1, "control");
  assert.equal(ownerWordWakes({ rows: [word({ ask_outdated_at: T })], now: T + 60 * MIN }).length, 0);
});

test("reader: the owner's last word on the thread of an outdated ask is no stall line (the store's query), and is one on an ordinary ask", async () => {
  const { db, mk } = await board();
  const a = await mk(), ctl = await mk();
  await callOff(db, a.id);
  for (const [id, n] of [[a.id, 1], [ctl.id, 2]]) await db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at) VALUES (?, ?, 'owner', 'what do you mean?', ?)").bind(`m-od-${n}`, id, T + 5 * MIN).run();
  await wakeAsk(db, T + 5 * MIN + 3 * 60 * MIN);
  const said = (await takeInbox(db, T + 5 * MIN + 3 * 60 * MIN + 1)).stalls.map((s) => s.reason).filter((r) => /owner's word/.test(r));
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.match(said[0], new RegExp(`#T${ctl.num} ends`));
});

test("reader: the wait counts (read_view summary openAsks) skip it, and a new hold cannot end on it, while an ordinary open ask does both", async () => {
  const { db, mk } = await board();
  const a = await mk(), ctl = await mk();
  await callOff(db, a.id);
  const view = await readView(db, T + 2 * MIN);
  assert.equal(viewForTool(view, { summary: true }).openAsks, 1, "only the ordinary one");
  const hold = (ref) => updateCard(db, T + 3 * MIN, "Manager", { id: "c900-thing", blocked_reason: "waiting", next_note: "waiting on the ask", hold_end: ref });
  assert.equal(rule(await hold(a.id)), "hold-end-unknown", "a hold that ends on a called-off ask is refused");
  assert.equal((await hold(ctl.id)).ok, true, "control");
});

test("reader: a hold whose end is the ask ends when the ask is called off (the store's passed-ends read)", async () => {
  const { db, mk } = await board();
  const a = await mk();
  assert.equal((await updateCard(db, T, "Manager", { id: "c900-thing", blocked_reason: "waiting on the ask", next_note: "waiting on the ask", hold_end: a.id })).ok, true);
  const ended = async (now) => { await wakeAsk(db, now); return (await takeInbox(db, now + 1)).stalls.filter((s) => /its end has passed/.test(s.reason)).length; };
  assert.equal(await ended(T + 5 * MIN), 0, "control: the ask is open, the hold's end has not come");
  await callOff(db, a.id, "no longer needed", {}, T + 6 * MIN);
  assert.equal(await ended(T + 7 * MIN), 1, "called off: the hold's end has come, so Manager is told to lift or renew it");
});

test("his answer to an outdated ask is kept exactly as today and reaches Manager through the inbox with a note naming the call-off; an ordinary answer has no note", async () => {
  const { db, mk } = await board();
  const a = await mk(), ctl = await mk();
  await callOff(db, a.id, "Manager changed the plan");
  const r = await answerAsk(db, T + 5 * MIN, "owner", { id: a.id, answer: "Done" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const kept = await row(db, a.id);
  assert.equal(kept.answer, "Done");
  assert.equal(kept.answered_by, "owner");
  assert.equal(kept.closed_at, null);
  await answerAsk(db, T + 5 * MIN, "owner", { id: ctl.id, answer: "Done" });
  const got = await takeInbox(db, T + 6 * MIN);
  const mine = got.answers.find((x) => x.id === a.id), plain = got.answers.find((x) => x.id === ctl.id);
  assert.equal(mine.answer, "Done");
  assert.equal(mine.outdated_note, `You called ask #T${a.num} off ('Manager changed the plan'); the owner answered it anyway: Done. Check whether his action still needs undoing.`);
  assert.equal(plain.outdated_note, undefined);
});

test("the tool is on Manager's door only, takes its session like every write, and works through the door", async () => {
  const env = { DB: makeDb(), CONNECTOR_HASH: await sha(SECRET), MANAGER_CONNECTOR_HASH: await sha(MSECRET) };
  const rpc = async (secret, params, method = "tools/call") => (await (await worker.fetch(new Request(`https://board.test/mcp/${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env, null, T, async () => null)).json()).result;
  const names = async (secret) => (await rpc(secret, {}, "tools/list")).tools.map((t) => t.name);
  assert.equal((await names(MSECRET)).includes("ask_outdate"), true);
  assert.equal((await names(SECRET)).includes("ask_outdate"), false, "not on the shared connector");
  const noSession = await rpc(MSECRET, { name: "ask_outdate", arguments: { id: "t1", reason: "x" } });
  assert.equal(noSession.isError, true);
  assert.notEqual(rule(noSession), "ask-unknown", "the session check comes before the tool");
  const asked = await createAsk(env.DB, T, terminal());
  const done = await rpc(MSECRET, { name: "ask_outdate", arguments: { session: SESSION, id: asked.id, reason: "Manager changed the plan" } });
  assert.equal(done.isError, false, JSON.stringify(done));
  assert.equal((await row(env.DB, asked.id)).outdated_by, "Manager");
  assert.equal(await rpc(SECRET, { name: "ask_outdate", arguments: { as: "Manager", id: asked.id, reason: "x" } }), undefined, "the shared door has no such tool");
});
