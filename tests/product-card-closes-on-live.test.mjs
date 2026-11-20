// #C1378 (the owner's pick A on #T2194; replaces #C1104 part 2's tests/landed-card-closes-itself.test.mjs): one table says what a repository word means
// (repoKind). A product card, a card of any named repository that is not the board's own, never waits on an install and closes when it reads live, not at landing.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import * as rules from "../worker/board-rules.mjs";
import { createCard, updateCard, writeEvidence } from "../worker/board-store.mjs";

const { repoKind, installWaitStep } = rules;
const T = 1_800_000_000_000;
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", REPO = "acme/widgets";
const LANDED = { lit: ["ship"], phase: "ship", headSha: SHA, repoFull: REPO, onMain: true };
const LIVE = { ...LANDED, lit: ["live"], phase: "live" };
const card = async (db, id, extra = {}) => { const r = await createCard(db, T, "Manager", { id, title: id, owner_role: "Builder", ...extra }); assert.equal(r.ok, true, JSON.stringify(r)); };
const row = (db, id) => db.prepare("SELECT * FROM cards WHERE id = ?").bind(id).first();
const read = async (db, id, v, at) => { const r = await writeEvidence(db, at, "probe", `cards.${id}`, v); assert.equal(r.ok, true, JSON.stringify(r)); };
const waits = (db, id) => db.prepare("SELECT kind FROM phase_history WHERE card_id = ? AND wait = 'install'").bind(id).all().then((r) => r.results);

test("repoKind: the board's own words answer board, any other named repository answers product", () => {
  for (const w of ["flight-board", "board", "Flight-Board", "acme/flight-board", "flight-board.git", " board "]) assert.equal(repoKind(w), "board", w);
  for (const w of ["widgets", "Gadgets", "acme/widgets", "widgets.git"]) assert.equal(repoKind(w), "product", w);
  for (const w of ["", "  ", null, undefined]) assert.equal(repoKind(w), "board", `no word reads as before: ${String(w)}`);
});

test("closesAtLanding is gone: no rule closes a card at landing", () => {
  assert.equal(rules.closesAtLanding, undefined);
});

test("installWaitStep: a card of a product repository never waits on an install, a board card still does", () => {
  assert.equal(installWaitStep({ repo: "widgets", next: "ship", onMain: true, open: false }), null, "a product card with a repository word");
  assert.equal(installWaitStep({ repo: "gadgets", next: "ship", onMain: true, open: false }), null);
  assert.equal(installWaitStep({ repo: "widgets", next: "ship", onMain: true, open: true }), "end", "a wait the old rule opened ends at the next reading");
  assert.equal(installWaitStep({ repo: "flight-board", next: "ship", onMain: true, open: false }), "start");
});

test("a card of a product repository stays open at landing, gets no install wait, and closes when it reads live with its commit as evidence", async () => {
  const db = makeDb(); await card(db, "docs", { repo: "widgets" });
  await read(db, "docs", { lit: ["checker"], phase: "checker", headSha: SHA, repoFull: REPO, onMain: false }, T + 1);
  await read(db, "docs", LANDED, T + 5);
  const open = await row(db, "docs");
  assert.equal(open.done_at, null, "on main is not live: it stays open");
  assert.deepEqual(await waits(db, "docs"), [], "no install wait on a product card");
  await read(db, "docs", LIVE, T + 9);
  const c = await row(db, "docs");
  assert.equal(c.done_at, T + 9); assert.equal(c.done_evidence, `https://github.com/${REPO}/commit/${SHA}`);
  await read(db, "docs", { ...LIVE, headSha: "f".repeat(40) }, T + 9000);
  assert.equal((await row(db, "docs")).done_at, T + 9, "a later reading does not rewrite it");
});

test("a board card still waits on its install and closes when it reads live", async () => {
  const db = makeDb(); await card(db, "boardcard", { repo: "flight-board" });
  await read(db, "boardcard", LANDED, T + 5);
  assert.equal((await row(db, "boardcard")).done_at, null);
  assert.deepEqual((await waits(db, "boardcard")).map((r) => r.kind), ["start"]);
  await read(db, "boardcard", LIVE, T + 9);
  assert.equal((await row(db, "boardcard")).done_at, T + 9);
  assert.deepEqual((await waits(db, "boardcard")).map((r) => r.kind), ["start", "end"]);
});

test("a dropped card, a card with a check date, and a reading with no full sha or repository stay open at live", async () => {
  const db = makeDb(); await card(db, "gone", { repo: "widgets" }); await card(db, "dated", { repo: "widgets" }); await card(db, "bare", { repo: "widgets" });
  await db.prepare("UPDATE cards SET dropped = 1 WHERE id = 'gone'").run();
  await updateCard(db, T, "Manager", { id: "dated", check_at: T + 86_400_000 });
  await read(db, "gone", LIVE, T + 5); await read(db, "dated", LIVE, T + 5);
  await read(db, "bare", { lit: ["live"], phase: "live", onMain: true }, T + 5);
  for (const id of ["gone", "dated", "bare"]) assert.equal((await row(db, id)).done_at, null, id);
});
