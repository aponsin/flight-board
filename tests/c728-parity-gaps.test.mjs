// #C728: four gaps Designer found in the store's /board at 8ff87ce. Three are the page's: the Manager chip and the ETA box are
// "not yet" on the store (PARITY: B1; B3b, B4), and Time spent shows every day and sorts its agents. The fourth (the shipped
// feed) is the probe's: it never reports a version without collector.versionPattern (state.mjs), so it is not tested here.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { drawPage } from "./helpers/draw-page.mjs";
import { createCard, writeEvidence, readView, refuse } from "../worker/board-store.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { writeUsageDay, readUsage, applyUsage } from "../worker/compat-usage.mjs";

const NOW = Date.now(); // the page reads its own clock
const M = 60_000;
const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// A store with one card worked by Builder (3 h ago) then Checker (1 h ago), as the probe reads it.
async function store() {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "hero", title: "Hero band", owner_role: "Builder" });
  await writeEvidence(db, NOW - 3 * 60 * M, "probe", "agents", { Builder: { state: "working", card: "hero" } });
  await writeEvidence(db, NOW - 3 * 60 * M, "probe", "cards.hero", { lit: ["build"], phase: "build" });
  await writeEvidence(db, NOW - 60 * M, "probe", "agents", { Checker: { state: "working", card: "hero" } });
  await writeEvidence(db, NOW - 60 * M, "probe", "cards.hero", { lit: ["checker"], phase: "checker" });
  return db;
}
const draw = async (db, host = "store", tweak = (c) => c) => {
  const view = { ...(await readView(db, NOW)), usage: await readUsage(db) };
  const { collections, probe } = compatView(view);
  return drawPage(tweak(applyUsage(collections, view)), { probe, host, expose: ["managerChip"] });
};

test("(3) the Manager chip is not drawn on the store; the artifact page still draws it from the wake watch", async () => {
  // The probe's board part as the live store has it: the old wake watch's heartbeat is none (Designer's red chip).
  const db = await store();
  const w = await writeEvidence(db, NOW - M, "probe", "board", { boardId: "flight-board", at: NOW - M, probe: "a".repeat(12), wakeAliveAt: null, wakeSeenAt: null });
  assert.equal(w.ok, true, JSON.stringify(w));
  const onStore = await draw(db);
  assert.equal(onStore.b.managerChip(), null);
  assert.doesNotMatch(onStore.els.mgrchip?.textContent ?? "", /not listening/);
  const artifact = await draw(db, null);
  assert.match(artifact.b.managerChip()?.text ?? "", /Manager not listening/, "the same data on the artifact page draws the chip");
});

test("(4) on the store a card's ETA box says — even with a history to estimate from; the artifact page still estimates", async () => {
  const db = await store();
  const withEta = (c) => ({ ...c, initiatives: c.initiatives.map((i) => ({ ...i, etaLive: NOW + 5 * M })) });
  const onStore = await draw(db, "store", withEta);
  assert.match(onStore.html, /<div class="lbl">ETA<\/div><div class="big">—<\/div>/);
  assert.doesNotMatch(onStore.html, /Live in/);
  const artifact = await draw(db, null, withEta);
  assert.match(artifact.html, /Live in/, "the artifact page draws its ETA");
});

test("(5) the per-agent table lists the most working first when nobody was queued", async () => {
  // Builder first in the history but only 30 min; Checker after it, 2 h 30.
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "hero", title: "Hero band", owner_role: "Builder" });
  await writeEvidence(db, NOW - 3 * 60 * M, "probe", "agents", { Builder: { state: "working", card: "hero" } });
  await writeEvidence(db, NOW - 3 * 60 * M, "probe", "cards.hero", { lit: ["build"], phase: "build" });
  await writeEvidence(db, NOW - 150 * M, "probe", "agents", { Checker: { state: "working", card: "hero" } });
  await writeEvidence(db, NOW - 150 * M, "probe", "cards.hero", { lit: ["checker"], phase: "checker" });
  const { els } = await draw(db);
  const order = [...els.qtable.innerHTML.matchAll(/<tr><td>([^<]+)<\/td>/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 2), ["Checker", "Builder"], els.qtable.innerHTML);
});

test("(5) the chart shows every day from the first to today, a quiet one as an empty column", async () => {
  const db = await store();
  const fourAgo = localDay(NOW - 4 * 864e5);
  await writeUsageDay(db, NOW, { day: fourAgo, runner_minutes: 60 }, refuse);
  const { els } = await draw(db);
  for (let n = 4; n >= 0; n--) {
    const d = localDay(NOW - n * 864e5);
    assert.match(els.chart.innerHTML, new RegExp(`>${d.slice(5)}</text>`), `${d} has a column`);
  }
});
