// #C1379: migration 0040 ends the false install waits on product cards, by the same rule the dry run prints. Idempotent; it touches no card.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { DELETE_FALSE_WAITS, LIST_FALSE_WAITS, PRODUCT_CARDS } from "../worker/repair-false-install-waits.mjs";
import { repoKind } from "../worker/board-rules.mjs";
import { dryRun } from "../scripts/repair-false-install-waits.mjs";

const MIGRATION = readFileSync(new URL("../worker/migrations/0040_repair_false_install_waits.sql", import.meta.url), "utf8");
const WORDS = ["flight-board", "board", "Flight-Board", "acme/flight-board", "flight-board.git", " board ", "x/y/board.git", "widgets", "Gadgets", "acme/widgets", "widgets.git", "my-board", "boardwalk", "flight-boards", "", "  ", null];

test("the migration holds the shared rule's DELETE verbatim", () => {
  assert.ok(MIGRATION.includes(DELETE_FALSE_WAITS), "0040 must contain DELETE_FALSE_WAITS exactly");
});

test("the rule's repository test says what repoKind says, for board and product words", () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec("CREATE TABLE cards (id TEXT PRIMARY KEY, repo TEXT)");
  WORDS.forEach((w, i) => sql.prepare("INSERT INTO cards (id, repo) VALUES (?, ?)").run(`c${i}`, w));
  const product = new Set(sql.prepare(PRODUCT_CARDS).all().map((r) => r.id));
  WORDS.forEach((w, i) => assert.equal(product.has(`c${i}`), typeof w === "string" && w.trim() !== "" && repoKind(w) === "product", `word ${JSON.stringify(w)}`));
});

const fill = async (db) => {
  const T = 1_800_000_000_000;
  for (const [id, repo, done] of [["prod", "gadgets-app", T], ["prodopen", "widgets", null], ["boardc", "flight-board", null], ["noword", null, null]]) {
    await db.prepare("INSERT INTO cards (id, title, owner_role, repo, num, created_at, updated_at, done_at) VALUES (?, ?, 'Builder', ?, ?, ?, ?, ?)").bind(id, id, repo, 9000 + Math.floor(Math.random() * 900), T, T, done).run();
  }
  const ph = (id, phase, kind, at, wait, source, who = "owner") => db.prepare("INSERT INTO phase_history (card_id, phase, kind, at, who, source, wait) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, phase, kind, at, who, source, wait).run();
  await ph("prod", "ship", "start", T + 1, "install", "evidence"); await ph("prod", "ship", "end", T + 2, "install", "evidence");
  await ph("prod", "ship", "start", T + 3, null, "evidence", "Release"); await ph("prod", "ship", "start", T + 4, "busy", "tool", "Release");
  await ph("prodopen", "ship", "start", T + 5, "install", "evidence");
  // Security's INFO on 653321f5: a row with wait 'install' that the store's evidence write did NOT write (source 'tool') on a product card must survive the repair.
  await ph("prod", "ship", "start", T + 7, "install", "tool");
  await ph("boardc", "ship", "start", T + 6, "install", "evidence");
};
const rows = (db) => db.prepare("SELECT card_id, phase, kind, wait, source FROM phase_history ORDER BY id").all().then((r) => r.results);
const cardsNow = (db) => db.prepare("SELECT id, done_at, repo FROM cards ORDER BY id").all().then((r) => r.results);

test("the migration removes only a product card's install waits written by the evidence write; no card changes", async () => {
  const db = makeDb(); await fill(db);
  const before = await cardsNow(db);
  const listed = (await db.prepare(LIST_FALSE_WAITS).all()).results;
  assert.deepEqual(listed.map((r) => `${r.card_id}:${r.kind}`), ["prod:start", "prod:end", "prodopen:start"], "the dry run lists exactly what goes");
  const raw = db.prepare(DELETE_FALSE_WAITS);
  const r = await raw.run();
  assert.equal(r.meta.changes, 3);
  assert.deepEqual((await rows(db)).map((x) => `${x.card_id}:${x.phase}:${x.kind}:${x.wait}:${x.source}`), ["prod:ship:start:null:evidence", "prod:ship:start:busy:tool", "prod:ship:start:install:tool", "boardc:ship:start:install:evidence"], "the probe's own row, the step tool's wait, an install row not written by the evidence write, and the board card's install wait stay");
  assert.deepEqual(await cardsNow(db), before, "no card row changes: nothing is reopened, done_at stays");
});

test("a second run changes nothing", async () => {
  const db = makeDb(); await fill(db);
  await db.prepare(DELETE_FALSE_WAITS).run();
  const once = await rows(db);
  const again = await db.prepare(DELETE_FALSE_WAITS).run();
  assert.equal(again.meta.changes, 0);
  assert.deepEqual(await rows(db), once);
  assert.deepEqual((await db.prepare(LIST_FALSE_WAITS).all()).results, [], "the dry run of a repaired store is empty");
});

test("the dry-run script reads a board view and lists the same cards, and the closed product cards still reading ship", () => {
  const view = {
    cards: [
      { id: "prod", num: 1, repo: "gadgets", done_at: 5, dropped: 0 }, { id: "boardc", num: 2, repo: "flight-board", done_at: null, dropped: 0 },
      { id: "late", num: 3, repo: "gadgets", done_at: 7, dropped: 0 }, { id: "gone", num: 4, repo: "gadgets", done_at: 7, dropped: 1 },
    ],
    history: [
      { id: 1, card_id: "prod", kind: "start", at: 10, wait: "install" }, { id: 2, card_id: "boardc", kind: "start", at: 11, wait: "install" },
      { id: 3, card_id: "prod", kind: "start", at: 12, wait: null },
    ],
    evidence: { "cards.prod": { value: { phase: "ship", headSha: "a".repeat(40) } }, "cards.late": { value: { phase: "live" } }, "cards.gone": { value: { phase: "ship" } } },
  };
  const out = dryRun(view);
  assert.deepEqual(out.waits, [{ id: "prod", num: 1, rows: [{ kind: "start", at: 10 }] }]);
  assert.deepEqual(out.early.map((c) => c.id), ["prod"], "a live reading, a dropped card and a board card are not in it");
});
