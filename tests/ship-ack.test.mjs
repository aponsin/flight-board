// The owner acknowledges what went live (#C874, docs/DATA.md rows 40 and 41): the page's route onto the store's ackShip,
// the Acknowledge button on each ship in the feed, and the "Went live, not yet acknowledged" list of the last 7 days.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { drawPage } from "./helpers/draw-page.mjs";
import worker from "../worker/board-worker.mjs";
import { createCard, writeEvidence, readView, ackShip } from "../worker/board-store.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { noteShip, readShips, applyShips } from "../worker/compat-ships.mjs";

const NOW = Date.now(); // the page reads its own clock for "the last 7 days"
const M = 60_000, DAY = 864e5;

async function live(db, at, id, version) {
  const value = { lit: ["live"], phase: "live", liveVersion: version };
  assert.equal((await writeEvidence(db, at, "probe", `cards.${id}`, value)).ok, true);
  await noteShip(db, at, id, value);
}
const post = (db, role, who, body, raw) => worker.fetch(new Request("https://b.test/api/ack", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }), { DB: db }, null, NOW, async () => ({ who, role }));
async function drawn(db, host = "store") {
  const view = { ...(await readView(db, NOW)), ships: await readShips(db) };
  const { collections, probe } = compatView(view);
  return drawPage(applyShips(collections, view), { probe, host });
}

test("ackShip: a version the probe recorded, once; an unknown or second ack is refused and logged", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "a", title: "A" });
  await live(db, NOW - 10 * M, "a", "1.4.0");
  assert.deepEqual(await ackShip(db, NOW, "owner", "1.4.0"), { ok: true, version: "1.4.0" });
  assert.equal((await readShips(db))[0].acked_at, NOW);
  const twice = await ackShip(db, NOW + M, "owner", "1.4.0");
  assert.deepEqual(twice, { ok: false, refused: { rule: "ship-already-acked", detail: "1.4.0" } });
  assert.equal((await readShips(db))[0].acked_at, NOW, "the first time stands");
  for (const v of ["9.9.9", null, 140]) assert.equal((await ackShip(db, NOW, "owner", v)).refused?.rule, "ship-unknown", String(v));
});

test("the page's route /api/ack is the owner's: the owner acknowledges, anyone else gets 403, a bad body 400, a refusal 422", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "a", title: "A" });
  await live(db, NOW - 10 * M, "a", "1.4.0");
  for (const [role, who] of [["agent", "Manager"], ["probe", "probe"]]) assert.equal((await post(db, role, who, { version: "1.4.0" })).status, 403, role);
  assert.equal((await readShips(db))[0].acked_at, null, "no ack from anyone but the owner");
  assert.equal((await post(db, "owner", "owner", null, "{not json")).status, 400);
  const ok = await post(db, "owner", "owner", { version: "1.4.0" });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, version: "1.4.0" });
  assert.equal((await readShips(db))[0].acked_at, NOW);
  assert.equal((await post(db, "owner", "owner", { version: "1.4.0" })).status, 422, "once");
  assert.equal((await post(db, "owner", "owner", { version: "2.0.0" })).status, 422, "only a version the probe recorded");
});

test("the store's page: an Acknowledge button on each waiting ship, the time on an acknowledged one, and the list of the last 7 days", async () => {
  const db = makeDb();
  for (const [id, title] of [["hero", "Hero band"], ["menu", "Menu page"], ["old", "Old card"]]) await createCard(db, NOW, "Manager", { id, title });
  await live(db, NOW - 30 * M, "hero", "2.5.0");
  await live(db, NOW - 2 * DAY, "menu", "2.4.0");
  await live(db, NOW - 8 * DAY, "old", "2.3.0");
  const before = await drawn(db);
  const list = before.els.unacked;
  assert.equal(list.hidden, false);
  assert.match(list.innerHTML, /^<div class="ulbl">Went live, not yet acknowledged \(2\)<\/div>/);
  assert.ok(list.innerHTML.indexOf("2.5.0") < list.innerHTML.indexOf("2.4.0"), "newest first");
  assert.match(list.innerHTML, /data-ack="2\.5\.0"/); assert.match(list.innerHTML, /data-ack="2\.4\.0"/);
  assert.doesNotMatch(list.innerHTML, /2\.3\.0/, "older than 7 days: not in the list");
  for (const v of ["2.5.0", "2.4.0", "2.3.0"]) assert.match(before.els.feed.innerHTML, new RegExp(`<button type="button" class="ackbtn" data-ack="${v.replaceAll(".", "\\.")}" aria-label="Acknowledge v${v.replaceAll(".", "\\.")}">Acknowledge</button>`), `the feed's ${v}`);
  await ackShip(db, NOW, "owner", "2.5.0");
  const after = await drawn(db);
  assert.match(after.els.unacked.innerHTML, /not yet acknowledged \(1\)/);
  assert.doesNotMatch(after.els.unacked.innerHTML, /2\.5\.0/);
  assert.match(after.els.feed.innerHTML, /<small class="acked" title="You acknowledged v2\.5\.0">acknowledged /);
  assert.doesNotMatch(after.els.feed.innerHTML, /data-ack="2\.5\.0"/);
  await ackShip(db, NOW, "owner", "2.4.0");
  const done = await drawn(db);
  assert.equal(done.els.unacked.hidden, true, "nothing waiting: the list is gone");
  assert.equal(done.els.unacked.innerHTML, "");
});

test("the artifact page has no store to write to: no button, no list", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "a", title: "A" });
  await live(db, NOW - 10 * M, "a", "1.4.0");
  const page = await drawn(db, "artifact");
  assert.doesNotMatch(page.els.feed.innerHTML, /ackbtn|acked/);
  assert.equal(page.els.unacked.hidden, true);
});

test("a click on Acknowledge posts the version to /api/ack, only on the store's page, and says Not saved when refused", () => {
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /closest\("\[data-ack\]"\):null;if\(!b\|\|!STORE\|\|b\.disabled\)return;/);
  assert.match(html, /fetch\("\/api\/ack",\{method:"POST",headers:\{"content-type":"application\/json"\},credentials:"same-origin",body:JSON\.stringify\(\{version:b\.dataset\.ack\}\)\}\)/);
  assert.match(html, /catch\(_\)\{b\.textContent="Not saved";setTimeout/);
  assert.match(html, /<div class="unacked" id="unacked" hidden><\/div><div class="feedwrap">/);
});
