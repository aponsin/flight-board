// #C926: on the store a card reads "building" from the moment its builder takes it (the dispatch's wake writes the build start,
// #C903; the builder's first Edit/Bash is the probe's agents.<role>.card), and "building, nothing pushed yet" until the first push;
// Started is that moment. A card not taken stays queued; a builder tile with no card stays idle.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, readView, recordBuildStart } from "../worker/board-store.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { drawPage } from "./helpers/draw-page.mjs";

const NOW = Date.now(), MIN = 60e3;
const seed = async () => {
  const db = makeDb();
  await createCard(db, NOW - 3 * 60 * MIN, "Manager", { id: "c-taken", title: "Taken card", owner_role: "Builder" });
  await createCard(db, NOW - 3 * 60 * MIN, "Manager", { id: "c-wait", title: "Waiting card", owner_role: "Builder" });
  return db;
};
const draw = async (db, host = "store") => { const { collections, probe } = compatView(await readView(db, NOW)); return drawPage(collections, { probe, host }); };
// One card's row of the board, by its name.
const rowOf = (html, name) => { const i = html.indexOf(`<strong>${name}</strong>`); assert.ok(i >= 0, `${name} is drawn`); return html.slice(i, html.indexOf('<div class="i-row', i + 1) < 0 ? undefined : html.indexOf('<div class="i-row', i + 1)); };

test("a dispatched card with nothing pushed reads building, nothing pushed yet, and Started is the wake; an untaken card reads queued", async () => {
  const db = await seed();
  assert.deepEqual(await recordBuildStart(db, NOW - 20 * MIN, "c-taken"), { ok: true, recorded: true });
  const d = await draw(db);
  const taken = rowOf(d.html, "Taken card"), wait = rowOf(d.html, "Waiting card");
  assert.match(taken, /<span class="state active">Building<\/span>/);
  assert.match(taken, /building, nothing pushed yet/);
  assert.doesNotMatch(taken, /Queued/);
  assert.match(taken, /Started /, "Started is drawn (the build start), not 'Queued N min'");
  assert.match(wait, /<span class="state \w+">Queued<\/span>/);
  assert.doesNotMatch(wait, /nothing pushed yet/);
});

test("the first push keeps it building with the usual line: no 'nothing pushed yet' once the probe has read its work", async () => {
  const db = await seed();
  await recordBuildStart(db, NOW - 20 * MIN, "c-taken");
  await writeEvidence(db, NOW - 5 * MIN, "probe", "cards.c-taken", { lit: ["build"], phase: "build", headSha12: "abc123def456", workSeen: true });
  const taken = rowOf((await draw(db)).html, "Taken card");
  assert.doesNotMatch(taken, /nothing pushed yet/);
  assert.doesNotMatch(taken, /Queued/);
});

test("the builder on the card (the probe's agents reading) is building too; a builder tile with no card stays idle", async () => {
  const db = await seed();
  await writeEvidence(db, NOW - 1 * MIN, "probe", "agents", { Builder: { state: "working", card: "c-wait", since: NOW - 2 * MIN } });
  const working = await draw(db);
  assert.doesNotMatch(rowOf(working.html, "Waiting card"), /<span class="state \w+">Queued</, "the builder's first Edit/Bash takes it");
  const idle = await seed();
  await writeEvidence(idle, NOW - 1 * MIN, "probe", "agents", { Builder: { state: "idle" } });
  const d = await draw(idle);
  assert.match(rowOf(d.html, "Waiting card"), /<span class="state \w+">Queued<\/span>/);
  assert.match(rowOf(d.html, "Taken card"), /<span class="state \w+">Queued<\/span>/);
});

test("the artifact page keeps its rule: a lone logged start with no work seen is still queued there", async () => {
  const db = await seed();
  await recordBuildStart(db, NOW - 20 * MIN, "c-taken");
  const a = await draw(db, null);
  assert.match(rowOf(a.html, "Taken card"), /start logged|Queued/);
});
