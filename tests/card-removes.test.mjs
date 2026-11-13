// #C866 (the owner's "lean, delete", 2026-11-04): a card may say what it removes, one line, in `removes`. The store keeps it (migration 0034), the card tools take it,
// the view carries it, and the page draws it in the card's Details, escaped. A card without it is as before; null clears it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard, readView } from "../worker/board-store.mjs";
import { cardWriteRefusal } from "../worker/board-rules.mjs";
import { initiativeDoc } from "../worker/compat-view.mjs";

const T = 1_800_000_000_000;
const cardOf = async (db, id) => (await readView(db, T + 9000)).cards.find((c) => c.id === id);

test("a card keeps what it removes, the view carries it, and a card without it has none", async () => {
  const db = makeDb();
  assert.ok((await createCard(db, T + 1, "Manager", { id: "c1-lean", title: "Lean", owner_role: "Boardsmith", removes: "the old import tooling and its tests" })).ok);
  assert.ok((await createCard(db, T + 2, "Manager", { id: "c2-plain", title: "Plain", owner_role: "Boardsmith" })).ok);
  const lean = await cardOf(db, "c1-lean");
  assert.equal(lean.removes, "the old import tooling and its tests");
  assert.equal(initiativeDoc(lean, null).removes, "the old import tooling and its tests", "the page's feed carries it");
  assert.equal(initiativeDoc(await cardOf(db, "c2-plain"), null).removes, undefined, "a card written without it carries none");
});

test("an update sets it and null clears it; a write that leaves it alone keeps it", async () => {
  const db = makeDb();
  assert.ok((await createCard(db, T + 1, "Manager", { id: "c1-lean", title: "Lean", owner_role: "Boardsmith" })).ok);
  assert.ok((await updateCard(db, T + 2, "Manager", { id: "c1-lean", removes: "the keeper folder" })).ok);
  assert.equal((await cardOf(db, "c1-lean")).removes, "the keeper folder");
  assert.ok((await updateCard(db, T + 3, "Manager", { id: "c1-lean", next_note: "built" })).ok);
  assert.equal((await cardOf(db, "c1-lean")).removes, "the keeper folder", "another write leaves it");
  assert.ok((await updateCard(db, T + 4, "Manager", { id: "c1-lean", removes: null })).ok);
  assert.equal(initiativeDoc(await cardOf(db, "c1-lean"), null).removes, undefined, "null clears it");
});

test("what is not one plain line is refused: a long text, a line break, a control character, a number", () => {
  const ok = (v) => cardWriteRefusal({ id: "c1-lean", removes: v }, null);
  assert.equal(ok("one line of words"), null);
  assert.equal(ok(null), null);
  assert.equal(ok("x".repeat(300)), null);
  for (const bad of ["x".repeat(301), "two\nlines", "bell\u0007", "tab\there", 5, ["a"], { a: 1 }]) assert.equal(ok(bad)?.rule, "card-removes", JSON.stringify(bad));
});

test("the page draws it in the card's Details, escaped, and the tools name it", () => {
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(page, /Removes: <b>\$\{esc\(i\.removes\)\}<\/b>/, "escaped like the Next line");
  assert.match(page, /const detBody=`\$\{next\}\$\{removes\}\$\{heldFull\}`/, "inside the Details fold");
  const worker = readFileSync(new URL("../worker/board-worker.mjs", import.meta.url), "utf8");
  assert.equal(worker.split("removes: { type: [\"string\", \"null\"] }").length - 1, 2, "card_create and card_update both take it");
});
