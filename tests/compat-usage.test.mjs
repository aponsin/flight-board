// Time spent, the usage tiles and the per-agent table (#C726 C3): the probe's daily usage rows through their route and the
// module, and the old page drawing Time spent and "Last 7 days, per agent" from a real store's phase history.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { drawPage } from "./helpers/draw-page.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, writeEvidence, readView, refuse } from "../worker/board-store.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { usageDayRefusal, writeUsageDay, readUsage, applyUsage } from "../worker/compat-usage.mjs";

const NOW = Date.now(); // the page reads its own clock for "Today" and "7 days"
const M = 60_000;
const today = new Date(NOW).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString().slice(0, 10);

test("a day's reading: a real date not in the future, known fields only, numbers in range, at least one", () => {
  assert.equal(usageDayRefusal({ day: today, runner_minutes: 82, automation_minutes: 14, actions_usd: 0.11 }, NOW), null);
  assert.equal(usageDayRefusal({ day: "2026-13-40", runner_minutes: 1 }, NOW).rule, "usage-day");
  assert.equal(usageDayRefusal({ day: "2999-01-01", runner_minutes: 1 }, NOW).rule, "usage-day");
  assert.equal(usageDayRefusal({ day: today, runner_minutes: -1 }, NOW).rule, "usage-value");
  assert.equal(usageDayRefusal({ day: today, actions_usd: "0.11" }, NOW).rule, "usage-value");
  assert.equal(usageDayRefusal({ day: today, runner_minutes: Infinity }, NOW).rule, "usage-value");
  assert.equal(usageDayRefusal({ day: today, agent_minutes: 30 }, NOW).rule, "usage-shape", "agent minutes come from the history");
  assert.equal(usageDayRefusal({ day: today }, NOW).rule, "usage-shape");
  assert.equal(usageDayRefusal([today], NOW).rule, "usage-shape");
});

test("a second reading of a day replaces the fields it sends and keeps the others; the view's rows are the old usage docs", async () => {
  const db = makeDb();
  assert.equal((await writeUsageDay(db, NOW, { day: today, runner_minutes: 40, actions_usd: 0.1 }, refuse)).ok, true);
  assert.equal((await writeUsageDay(db, NOW, { day: today, runner_minutes: 82.4, automation_minutes: 14 }, refuse)).ok, true);
  assert.equal((await writeUsageDay(db, NOW, { day: today, runner_minutes: -5 }, refuse)).refused.rule, "usage-value");
  const c = applyUsage({}, { usage: await readUsage(db) });
  assert.deepEqual(c.usage, [{ id: today, day: today, runnerMin: 82, actionsMin: 14, actionsUsd: 0.1 }]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule = 'usage-value'").first()).n, 1);
  assert.deepEqual(applyUsage({ usage: ["kept"] }, {}), { usage: ["kept"] }, "a view without usage leaves the collection alone");
});

test("POST /api/probe/usage is the probe's alone", async () => {
  const env = { DB: makeDb() };
  const WHO = { owner: { who: "owner", role: "owner" }, manager: { who: "Manager", role: "agent" }, probe: { who: "probe", role: "probe" } };
  const post = (as, body) => worker.fetch(new Request("https://board.test/api/probe/usage", { method: "POST", headers: { "content-type": "application/json", "x-as": as }, body: JSON.stringify(body) }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  assert.equal((await post("owner", { day: today, runner_minutes: 1 })).status, 403);
  assert.equal((await post("manager", { day: today, runner_minutes: 1 })).status, 403);
  assert.equal((await post("probe", { day: today, runner_minutes: "x" })).status, 422);
  const ok = await post("probe", { day: today, runner_minutes: 30 });
  assert.equal(ok.status, 200);
  assert.equal((await readUsage(env.DB))[0].runner_minutes, 30);
});

test("the old page draws Time spent and the per-agent table from the store: runner minutes from the rows, agents from the history", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "hero", title: "Hero band", owner_role: "Builder" });
  await writeEvidence(db, NOW - 3 * 60 * M, "probe", "agents", { Builder: { state: "working", card: "hero" } });
  await writeEvidence(db, NOW - 3 * 60 * M, "probe", "cards.hero", { lit: ["build"], phase: "build" });
  await writeEvidence(db, NOW - 60 * M, "probe", "agents", { Checker: { state: "working", card: "hero" } });
  await writeEvidence(db, NOW - 60 * M, "probe", "cards.hero", { lit: ["checker"], phase: "checker" });
  await writeUsageDay(db, NOW, { day: today, runner_minutes: 90, automation_minutes: 30, actions_usd: 0.25 }, refuse);
  await writeUsageDay(db, NOW, { day: daysAgo(3), runner_minutes: 60 }, refuse);
  const view = { ...(await readView(db, NOW)), usage: await readUsage(db) };
  const { collections, probe } = compatView(view);
  const drawn = drawPage(applyUsage(collections, view), { probe, host: "store" });
  const totals = drawn.els.totals.innerHTML;
  assert.match(totals, /Today<\/div><div class="n">[^<]+<\/div><div class="l">\$0\.25 Actions/);
  assert.match(drawn.els.chart.innerHTML, /<svg/, "the chart draws the days");
  assert.match(drawn.els.chart.innerHTML, new RegExp(`${today}: agents`));
  // Two hours of Builder's build before Checker took it: "Working" in the table comes from the history alone.
  assert.match(drawn.els.qtable.innerHTML, /<td>Builder<\/td><td>2 ?h/);
  assert.match(drawn.els.qtable.innerHTML, /<td>Checker<\/td>/);
});
