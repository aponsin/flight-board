// #C1104 part 2: a card in a named repository with no install step closes when its commit is on main (the commit is the evidence). A board card
// waits for its install and closes when it reads live; a product card (no repo) goes live by its deploy; a card with a marked part not on main stays open.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, writeEvidence } from "../worker/board-store.mjs";
import { closesAtLanding } from "../worker/board-rules.mjs";

const T = 1_800_000_000_000;
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", REPO = "acme/widgets";
const LANDED = { lit: ["ship"], phase: "ship", headSha: SHA, repoFull: REPO, onMain: true };
const card = async (db, id, extra = {}) => { const r = await createCard(db, T, "Manager", { id, title: id, owner_role: "Builder", ...extra }); assert.equal(r.ok, true, JSON.stringify(r)); };
const row = (db, id) => db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
const read = async (db, id, v, at) => { const r = await writeEvidence(db, at, "probe", `cards.${id}`, v); assert.equal(r.ok, true, JSON.stringify(r)); };

test("the rule: a named repo that is no board repo, on main, with no marked part missing", () => {
  assert.equal(closesAtLanding({ repo: "widgets", onMain: true }), true);
  assert.equal(closesAtLanding({ repo: "widgets", onMain: true, partsMissing: [] }), true);
  assert.equal(closesAtLanding({ repo: "widgets", onMain: true, partsMissing: ["1a2b3c4"] }), false, "a marked part not on main keeps it open");
  assert.equal(closesAtLanding({ repo: "widgets", onMain: false }), false);
  assert.equal(closesAtLanding({ repo: "widgets" }), false);
  assert.equal(closesAtLanding({ repo: "flight-board", onMain: true }), false, "a board card waits for its install");
  assert.equal(closesAtLanding({ repo: "board", onMain: true }), false);
  assert.equal(closesAtLanding({ repo: "", onMain: true }), false, "a product card goes live by its deploy");
  assert.equal(closesAtLanding({ repo: null, onMain: true }), false);
  assert.equal(closesAtLanding({ repo: "  ", onMain: true }), false);
});

test("a card of another repository closes at the first reading with its commit on main, the commit as evidence", async () => {
  const db = makeDb(); await card(db, "docs", { repo: "widgets" });
  await read(db, "docs", { lit: ["checker"], phase: "checker", headSha: SHA, repoFull: REPO, onMain: false }, T + 1);
  assert.equal((await row(db, "docs")).done_at, null, "not on main yet");
  await read(db, "docs", LANDED, T + 5);
  const c = await row(db, "docs");
  assert.equal(c.done_at, T + 5); assert.equal(c.done_evidence, `https://github.com/${REPO}/commit/${SHA}`);
  await read(db, "docs", { ...LANDED, headSha: "f".repeat(40) }, T + 9000);
  assert.equal((await row(db, "docs")).done_at, T + 5, "a later reading does not rewrite it");
});

test("a board card and a product card stay open at landing; the board card closes when it reads live (#C832)", async () => {
  const db = makeDb(); await card(db, "boardcard", { repo: "flight-board" }); await card(db, "product");
  await read(db, "boardcard", LANDED, T + 5); await read(db, "product", LANDED, T + 5);
  assert.equal((await row(db, "boardcard")).done_at, null); assert.equal((await row(db, "product")).done_at, null);
  await read(db, "boardcard", { ...LANDED, lit: ["live"], phase: "live" }, T + 9);
  assert.equal((await row(db, "boardcard")).done_at, T + 9);
});

test("a card with a marked part not on main stays open until that part is on main", async () => {
  const db = makeDb(); await card(db, "parted", { repo: "widgets" });
  await read(db, "parted", { ...LANDED, partsMissing: ["1a2b3c4"] }, T + 5);
  assert.equal((await row(db, "parted")).done_at, null);
  await read(db, "parted", LANDED, T + 9);
  assert.equal((await row(db, "parted")).done_at, T + 9, "the part landed: the card closes");
});

test("a dropped card, a card with a check date, and a reading with no full sha or repository stay open", async () => {
  const db = makeDb(); await card(db, "gone", { repo: "widgets" }); await card(db, "dated", { repo: "widgets" }); await card(db, "bare", { repo: "widgets" });
  await db.prepare("UPDATE cards SET dropped = 1 WHERE id = 'gone'").run();
  await updateCard(db, T, "Manager", { id: "dated", check_at: T + 86_400_000 });
  await read(db, "gone", LANDED, T + 5); await read(db, "dated", LANDED, T + 5);
  await read(db, "bare", { lit: ["ship"], phase: "ship", onMain: true }, T + 5);
  for (const id of ["gone", "dated", "bare"]) assert.equal((await row(db, id)).done_at, null, id);
});
