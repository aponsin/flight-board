// Ships, "Done in the last 24 h" and the shipped feed (#C726 C2), from the probe's readings only: the module's rules, then a real
// store (the in-memory D1) through the compatibility view and the module into the old page's own drawing code.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { drawPage } from "./helpers/draw-page.mjs";
import { createCard, writeEvidence, readView, ackShip } from "../worker/board-store.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { noteShip, readShips, applyShips, plainVersion } from "../worker/compat-ships.mjs";

const NOW = Date.now(); // the page reads its own clock for "the last 24 h"
const M = 60_000;

// What the probe sends, and the hook Boardsmith adds after writeEvidence stores a card's reading.
async function read(db, now, id, phase, extra = {}) {
  const value = { lit: [phase], phase, ...extra };
  const r = await writeEvidence(db, now, "probe", `cards.${id}`, value);
  assert.equal(r.ok, true, JSON.stringify(r));
  await noteShip(db, now, id, value);
}
const viewOf = async (db, now) => ({ ...(await readView(db, now)), ships: await readShips(db) });

test("a version is plain digits, with or without its v; anything else is no version", () => {
  assert.equal(plainVersion("v1.209.0"), "1.209.0"); assert.equal(plainVersion("1.2.3"), "1.2.3");
  assert.equal(plainVersion("1.2"), null); assert.equal(plainVersion("v1.2.3<b>"), null); assert.equal(plainVersion(null), null);
});

test("the first reading of a version is its ship; a second card joins it and keeps the time; a reading twice adds nothing", async () => {
  const db = makeDb();
  for (const id of ["a", "b", "c"]) await createCard(db, NOW, "Manager", { id, title: id.toUpperCase() });
  await read(db, NOW - 30 * M, "a", "live", { liveVersion: "v1.2.0" });
  await read(db, NOW - 20 * M, "b", "live", { liveVersion: "v1.2.0" });
  await read(db, NOW - 10 * M, "a", "live", { liveVersion: "v1.2.0" });
  await read(db, NOW - 5 * M, "c", "ship", { liveVersion: null });
  assert.deepEqual(await readShips(db), [{ version: "1.2.0", cards: '["a","b"]', shipped_at: NOW - 30 * M, acked_at: null }]);
});

test("a card at its last phase is done, with when it got there and its version; earlier phases and dropped cards are not", async () => {
  const db = makeDb();
  for (const [id, title] of [["live-one", "Hero band"], ["building", "Menu"], ["board-card", "Tile"], ["dropped", "Old idea"]]) await createCard(db, NOW, "Manager", { id, title });
  await createCard(db, NOW, "Manager", { id: "gone", title: "Gone" });
  await read(db, NOW - 3 * 60 * M, "live-one", "ship");
  await read(db, NOW - 2 * 60 * M, "live-one", "live", { liveVersion: "v1.3.0" });
  await read(db, NOW - 60 * M, "live-one", "live", { liveVersion: "v1.3.0" });
  await read(db, NOW - 60 * M, "building", "build");
  await read(db, NOW - 50 * M, "board-card", "install");
  const { updateCard } = await import("../worker/board-store.mjs");
  assert.equal((await updateCard(db, NOW, "Manager", { id: "dropped", dropped: true })).ok, true);
  await read(db, NOW - 40 * M, "dropped", "live");
  const view = await viewOf(db, NOW);
  const c = applyShips(compatView(view).collections, view);
  const by = Object.fromEntries(c.initiatives.map((i) => [i.id, i]));
  assert.equal(by["live-one"].status, "done"); assert.equal(by["live-one"].doneAt, NOW - 2 * 60 * M, "the first time it was live, not the latest reading"); assert.equal(by["live-one"].version, "1.3.0");
  assert.equal(by["board-card"].status, "done"); assert.equal(by["board-card"].version, undefined);
  assert.equal(by.building.status, "active"); assert.equal(by.dropped.status, "dropped"); assert.equal(by.gone.status, "active");
  assert.deepEqual(c.events, [{ id: "v1.3.0", version: "1.3.0", at: NOW - 2 * 60 * M, cards: ["live-one"], text: "#C1 Hero band" }]);
});

test("a wait step on the end phase does not date the card's arrival there: doneAt is the probe's own row (#C739, Checker F4)", () => {
  const view = {
    cards: [{ id: "c1" }],
    evidence: { "cards.c1": { readAt: NOW - 60 * M, value: { lit: ["install"], liveVersion: null } } },
    history: [
      { card_id: "c1", phase: "install", kind: "start", at: NOW - 48 * 60 * M, who: "Release", wait: "busy" },
      { card_id: "c1", phase: "install", kind: "start", at: NOW - 60 * M, who: "Release", wait: null },
    ],
  };
  const c = applyShips({ initiatives: [{ id: "c1" }] }, view);
  assert.equal(c.initiatives[0].status, "done"); assert.equal(c.initiatives[0].doneAt, NOW - 60 * M);
  const only = applyShips({ initiatives: [{ id: "c1" }] }, { ...view, history: [view.history[0]] });
  assert.equal(only.initiatives[0].doneAt, NOW - 60 * M, "with only a wait row, the reading's own time");
});

test("a ship is dated by the probe's shippedAt when it is a time in the last 30 days, not by the reading; an earlier shippedAt from a later card moves it back (#C736 follow-up)", async () => {
  const db = makeDb();
  for (const id of ["a", "b", "c", "d"]) await createCard(db, NOW, "Manager", { id, title: id.toUpperCase() });
  await read(db, NOW - 5 * M, "a", "live", { liveVersion: "v2.0.0", shippedAt: NOW - 3 * 60 * M });
  assert.equal((await readShips(db))[0].shipped_at, NOW - 3 * 60 * M, "the commit's time, not the reading's");
  await read(db, NOW - 4 * M, "b", "live", { liveVersion: "v2.0.0", shippedAt: NOW - 4 * 60 * M });
  assert.equal((await readShips(db))[0].shipped_at, NOW - 4 * 60 * M, "an earlier card moves the ship back");
  assert.deepEqual(JSON.parse((await readShips(db))[0].cards), ["a", "b"]);
  await read(db, NOW - 3 * M, "c", "live", { liveVersion: "v2.0.0", shippedAt: NOW - 60 * M });
  assert.equal((await readShips(db))[0].shipped_at, NOW - 4 * 60 * M, "a later one leaves it");
  for (const [id, v, want] of [["d", "v3.0.0", NOW - 2 * M], ["d", "v3.1.0", NOW - 2 * M], ["d", "v3.2.0", NOW - 2 * M]]) {
    const bad = v === "v3.0.0" ? NOW + 10 * 60 * M : v === "v3.1.0" ? NOW - 40 * 864e5 : "yesterday";
    await read(db, NOW - 2 * M, id, "live", { liveVersion: v, shippedAt: bad });
    assert.equal((await readShips(db)).find((s) => s.version === v.slice(1)).shipped_at, want, `a shippedAt of ${String(bad)} is no time: the reading's`);
  }
});

test("the feed is newest first and carries the owner's ack; without ships in the view the feed is left alone", async () => {
  const db = makeDb();
  for (const id of ["a", "b"]) await createCard(db, NOW, "Manager", { id, title: `Card ${id}` });
  await read(db, NOW - 50 * M, "a", "live", { liveVersion: "1.0.1" });
  await read(db, NOW - 10 * M, "b", "live", { liveVersion: "1.0.2" });
  assert.equal((await ackShip(db, NOW, "owner", "1.0.1")).ok, true);
  const view = await viewOf(db, NOW);
  const events = applyShips(compatView(view).collections, view).events;
  assert.deepEqual(events.map((e) => [e.version, e.ackedAt ?? null]), [["1.0.2", null], ["1.0.1", NOW]]);
  const bare = compatView(view).collections;
  delete bare.events; // compatView applies the ships itself now (#C726 hook): start from a collection set without them
  assert.equal(applyShips(bare, { ...view, ships: undefined }).events, undefined);
});

test("the old page draws them: the Done list in the last 24 h with its version, and the shipped feed with the card links", async () => {
  const db = makeDb();
  for (const [id, title] of [["hero", "Hero band"], ["menu", "Menu page"], ["old", "Old card"]]) await createCard(db, NOW, "Manager", { id, title });
  await read(db, NOW - 30 * M, "hero", "live", { liveVersion: "v2.4.0" });
  await read(db, NOW - 20 * M, "menu", "live", { liveVersion: "v2.4.0" });
  await read(db, NOW - 26 * 60 * M, "old", "live", { liveVersion: "v2.3.0" });
  const view = await viewOf(db, NOW);
  const { collections, probe } = compatView(view);
  const drawn = drawPage(applyShips(collections, view), { probe, host: "store" });
  assert.match(drawn.els.donesum.textContent, /^Done in the last 24 h \(2\)$/);
  assert.match(drawn.els.doneboard.innerHTML, /Hero band/); assert.match(drawn.els.doneboard.innerHTML, /Menu page/);
  assert.doesNotMatch(drawn.els.doneboard.innerHTML, /Old card/, "older than 24 h: out of view, found by search");
  assert.match(drawn.els.doneboard.innerHTML, /<div class="lbl">Live<\/div><div class="big">2\.4\.0<\/div>/);
  assert.match(drawn.els.feed.innerHTML, /<span class="ver">2\.4\.0<\/span>/);
  assert.match(drawn.els.feed.innerHTML, /#C1/); assert.match(drawn.els.feed.innerHTML, /Menu page/);
  assert.match(drawn.els.feed.innerHTML, /2\.3\.0/, "the feed keeps every ship, of any age");
});
