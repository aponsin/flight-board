// #C730: on the store the old page's Manager chip and the "seen" ticks read the store's own wake (row 4: wakeAsk, wakeResult,
// takeInbox), carried as probe.board.wake by the compatibility view, not the old wake watch's wakeAliveAt / wakeSeenAt (#C728 hid
// the chip on the store because those were never there and it was red on every load). The artifact page is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { drawPage } from "./helpers/draw-page.mjs";
import { writeEvidence, readView, wakeAsk, wakeResult, takeInbox, postMessage } from "../worker/board-store.mjs";
import { compatView, probeDoc } from "../worker/compat-view.mjs";

const NOW = Date.now(); // the page reads its own clock
const M = 60_000;

// The probe's board part as the live store has it: the old wake watch's keys say nothing is listening and nothing was seen,
// and the Collector's marker is long quiet. The store's page must read neither.
async function store({ quietMin = 0 } = {}) {
  const db = makeDb();
  const w = await writeEvidence(db, NOW - 10_000, "probe", "board", { boardId: "flight-board", at: NOW - 10_000, probe: "a".repeat(12), wakeAliveAt: null, wakeSeenAt: null, derivedAt: NOW - 600 * M, quietMin });
  assert.equal(w.ok, true, JSON.stringify(w));
  return db;
}
const draw = async (db, host = "store") => {
  const { collections, probe } = compatView(await readView(db, NOW));
  return drawPage(collections, { probe, host, expose: ["managerChip", "seenTick", "OWNER", "hhmm"] });
};

test("the view carries the store's wake: state, reason, fix, the ask's age, and Manager's last read; no seenAt before one", async () => {
  const db = await store();
  assert.deepEqual(probeDoc(await readView(db, NOW)).board.wake, { state: "red", reason: "probe-not-asking", fix: "the probe has not asked the store for 3 min" }, "never asked: no askAge");
  await wakeAsk(db, NOW - 20_000);
  assert.deepEqual(probeDoc(await readView(db, NOW)).board.wake, { state: "idle", askAge: 20_000 });
  await takeInbox(db, NOW - 5_000);
  assert.equal(probeDoc(await readView(db, NOW)).board.wake.seenAt, NOW - 5_000);
});

test("a `wake` key in the probe's own board reading is never passed on: the store's replaces it, and with none it is dropped", async () => {
  const db = makeDb();
  const wr = await writeEvidence(db, NOW - 10_000, "probe", "board", { boardId: "flight-board", at: NOW - 10_000, wake: { state: "ok", askAge: 1 } });
  assert.equal(wr.ok, true, JSON.stringify(wr));
  const view = await readView(db, NOW);
  assert.equal(view.evidence.board.value.wake.state, "ok", "the reading carries its own wake");
  assert.equal(probeDoc(view).board.wake.state, "red", "the store's wake (never asked) wins");
  assert.equal(Object.hasOwn(probeDoc({ ...view, wakeState: undefined }).board, "wake"), false);
});

test("on the store the chip is hidden until the probe has asked the store once, though the old keys say not listening", async () => {
  const db = await store();
  assert.equal((await draw(db)).b.managerChip(), null);
  assert.match((await draw(db, null)).b.managerChip()?.text ?? "", /Manager not listening/, "the artifact page still reads the old keys");
});

test("on the store the chip is green while the probe asks the store, whatever the old wake watch's keys say", async () => {
  const db = await store();
  await wakeAsk(db, NOW - 20_000);
  const { b, els } = await draw(db);
  assert.deepEqual({ ...b.managerChip() }, { cls: "ok", text: "Manager listening" });
  assert.equal(els.mgrchip.textContent, "Manager listening");
});

test("on the store the chip is red with the store's fix: a probe that stopped asking, a send that failed", async () => {
  const db = await store();
  await wakeAsk(db, NOW - 4 * M);
  assert.deepEqual({ ...(await draw(db)).b.managerChip() }, { cls: "bad", text: "Manager not listening · the probe has not asked the store for 3 min" });
  await wakeAsk(db, NOW - 20_000);
  await wakeResult(db, NOW - 10_000, "b-1", 1, "OAuth session expired");
  assert.deepEqual({ ...(await draw(db)).b.managerChip() }, { cls: "bad", text: "Manager not listening · run `claude /login` in a Terminal on the Studio" });
});

test("on the store a long-quiet Collector does not turn the chip red (it is gone there); the artifact page still says so", async () => {
  const db = await store({ quietMin: 500 });
  await wakeAsk(db, NOW - 20_000);
  assert.equal((await draw(db)).b.managerChip()?.text, "Manager listening");
  const artifact = await draw(db, null);
  artifact.b.probeEvent({ type: "data", result: { payload: { ...probeDoc(await readView(db, NOW)), board: { ...probeDoc(await readView(db, NOW)).board, wakeAliveAt: NOW - 10_000 } } } });
  assert.match(artifact.b.managerChip()?.text ?? "", /Collector has not published/);
});

test("on the store \"seen\" and \"answer coming\" come from Manager's last typed read, not the old wakeSeenAt", async () => {
  const db = await store();
  await wakeAsk(db, NOW - 20_000);
  assert.equal((await postMessage(db, NOW - 10 * M, "owner", { thread_id: "t-1", body: "first" })).ok, true);
  assert.equal((await postMessage(db, NOW - 8 * M, "owner", { thread_id: "t-1", body: "second" })).ok, true);
  const msgs = (b) => [{ id: "m1", thread: "t-1", from: b.OWNER, text: "first", at: NOW - 10 * M }, { id: "m2", thread: "t-1", from: b.OWNER, text: "second", at: NOW - 8 * M }];

  let { b } = await draw(db);
  b.state.messages = msgs(b);
  assert.equal(b.seenTick(b.state.messages[1]), "", "not read yet: no tick");
  assert.equal(b.managerChip()?.text, "Manager listening");

  await takeInbox(db, NOW - 9 * M); // read after the first message, before the second
  ({ b } = await draw(db));
  b.state.messages = msgs(b);
  // The page's own hhmm gives the expected time, so the test holds in any locale (the review: a 12-hour clock, U+202F before AM).
  assert.equal(b.seenTick(b.state.messages[0]), `<div class="t-seen">seen ${b.hhmm(NOW - 9 * M)}</div>`);
  assert.equal(b.seenTick(b.state.messages[1]), "");

  await takeInbox(db, NOW - 5 * M);
  ({ b } = await draw(db));
  b.state.messages = msgs(b);
  assert.equal(b.seenTick(b.state.messages[0]), `<div class="t-seen">seen</div>`, "the older one: no time of its own");
  assert.equal(b.seenTick(b.state.messages[1]), `<div class="t-seen">seen ${b.hhmm(NOW - 5 * M)}</div>`);
  assert.equal(b.managerChip()?.text, `seen your ${b.hhmm(NOW - 8 * M)} message · answer coming`);
  assert.equal(b.managerChip()?.cls, "warn");
});
