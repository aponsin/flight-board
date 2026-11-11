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

test("(3) the Manager chip is not drawn on the store from the old wake watch's keys (#C730: it reads the store's wake, tests/c730-wake-chip.test.mjs); the artifact page still draws it from them", async () => {
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

test("(4) #C877: on the store a card's ETA box draws the estimate (Live in), as the artifact page does; a paused card still says —", async () => {
  const db = await store();
  const withEta = (c) => ({ ...c, initiatives: c.initiatives.map((i) => ({ ...i, etaLive: NOW + 5 * M })) });
  const onStore = await draw(db, "store", withEta);
  assert.match(onStore.html, /<div class="lbl">Live in<\/div>/);
  const artifact = await draw(db, null, withEta);
  assert.match(artifact.html, /Live in/, "the artifact page draws its ETA");
  // A card the lead paused, with no one working it (the page lights a card an agent works as in flight whatever is stored).
  const db2 = makeDb();
  await createCard(db2, NOW, "Manager", { id: "hero", title: "Hero band", owner_role: "Builder" });
  await db2.prepare("UPDATE cards SET paused = 1 WHERE id = 'hero'").run();
  const held = await draw(db2, "store", withEta);
  assert.match(held.html, /<div class="lbl">ETA<\/div><div class="big">—<\/div>/, "a paused card read as due (#C728): no ETA");
  assert.doesNotMatch(held.html, /<div class="lbl">Live in<\/div>/);
});

test("(4) #C877: the ETA is in the card number's bubble and a thread's card line on the store too, as on the artifact page", async () => {
  const db = await store();
  const withEta = (c) => ({ ...c, initiatives: c.initiatives.map((i) => ({ ...i, etaLive: NOW + 5 * M, thread: "t-1" })) });
  const at = async (host) => {
    const view = { ...(await readView(db, NOW)), usage: await readUsage(db) };
    const { collections, probe } = compatView(view);
    const { b } = drawPage(withEta(applyUsage(collections, view)), { probe, host, expose: ["cardBubble", "cardLine"] });
    const card = b.state.initiatives.find((i) => i.id === "hero");
    return { bubble: b.cardBubble(card), line: b.cardLine("t-1") };
  };
  const store_ = await at("store"), artifact = await at(null);
  assert.ok(card(artifact), "the artifact page's card line exists");
  assert.match(artifact.bubble, /due ~/); assert.match(artifact.line, /~\d/);
  assert.match(store_.bubble, /due ~/); assert.match(store_.line, /~\d/);
  function card(x) { return x.line.length > 0; }
});

test("(5) a usage day after today counts in no tile", async () => {
  const db = await store();
  const tomorrow = localDay(NOW + 864e5);
  const without = (await draw(db)).els.totals.innerHTML;
  const { els } = await draw(db, "store", (c) => ({ ...c, usage: [{ id: tomorrow, day: tomorrow, runnerMin: 600 }] }));
  assert.equal(els.totals.innerHTML, without, "tomorrow's 600 minutes are in no tile");
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

test("(5) a stray old usage day fills at most the last 30 days (Security on #C728)", () => {
  const { b } = drawPage({}, { host: "store", expose: ["fillDays"] });
  const keys = Object.keys(b.fillDays({ "1900-01-01": { day: "1900-01-01" } }, NOW));
  assert.ok(keys.length <= 33, `${keys.length} days`);
  assert.ok(keys.includes(localDay(NOW)) && keys.includes(localDay(NOW - 29 * 864e5)));
  assert.deepEqual(Object.keys(b.fillDays({}, NOW)), [], "no data, no days");
});

test("(5) in Mountain time (MST7MDT) at 11:30 pm on 2027-03-20 (UTC is already the 21st), after the spring clock change: every day, and today is the 20th", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const helper = fileURLToPath(new URL("./helpers/c728-days.mjs", import.meta.url));
  const days = (at) => { const r = spawnSync(process.execPath, [helper], { encoding: "utf8", env: { ...process.env, TZ: "MST7MDT", C728_NOW: String(at) } }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout).labels; };
  const run = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => `03-${String(from + k).padStart(2, "0")}`);
  assert.deepEqual(days(Date.UTC(2027, 2, 21, 5, 30)), run(7, 20), "11:30 pm on the 20th: today is the 20th");
  // 12:30 am on the 21st: 30 days back is 11:30 pm, and a day stepped from there jumped over the 23-hour 03-14 (Checker's replay).
  assert.deepEqual(days(Date.UTC(2027, 2, 21, 6, 30)), run(8, 21), "03-14 has its column");
});
