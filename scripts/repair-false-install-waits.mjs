// #C1379: the dry run of migration 0040. It reads the board view the shared connector's read_view saved to a file (no owner_role: the whole view), loads the cards
// and their phase history into an in-memory table, and runs the repair's own rule (worker/repair-false-install-waits.mjs: the migration holds the same text) as a SELECT.
// It changes nothing anywhere: no store, no file, no network. Output: one line per card with its false install rows (what the migration removes), and, as information
// for the collector's re-read, the closed product cards whose stored reading is not live (the audit's "71 closed at ship").
//   node scripts/repair-false-install-waits.mjs <view.json>
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LIST_FALSE_WAITS } from "../worker/repair-false-install-waits.mjs";
import { repoKind } from "../worker/board-rules.mjs";
import { isMain } from "./is-main.mjs";

export function dryRun(view) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE cards (id TEXT PRIMARY KEY, num INTEGER, repo TEXT, done_at INTEGER, dropped INTEGER); CREATE TABLE phase_history (id INTEGER PRIMARY KEY, card_id TEXT, kind TEXT, at INTEGER, wait TEXT, source TEXT);");
  const addCard = db.prepare("INSERT INTO cards (id, num, repo, done_at, dropped) VALUES (?, ?, ?, ?, ?)");
  for (const c of view.cards ?? []) addCard.run(c.id, c.num ?? null, c.repo ?? null, c.done_at ?? null, c.dropped ? 1 : 0);
  const addRow = db.prepare("INSERT INTO phase_history (id, card_id, kind, at, wait, source) VALUES (?, ?, ?, ?, ?, ?)");
  for (const h of view.history ?? []) addRow.run(h.id, h.card_id, h.kind, h.at, h.wait ?? null, h.source ?? "evidence");
  const num = new Map((view.cards ?? []).map((c) => [c.id, c.num]));
  const waits = new Map();
  for (const r of db.prepare(LIST_FALSE_WAITS).all()) { if (!waits.has(r.card_id)) waits.set(r.card_id, []); waits.get(r.card_id).push({ kind: r.kind, at: r.at }); }
  const early = (view.cards ?? []).filter((c) => c.done_at && !c.dropped && repoKind(c.repo) === "product" && (view.evidence?.[`cards.${c.id}`]?.value?.phase ?? null) === "ship")
    .map((c) => ({ id: c.id, num: c.num, phase: "ship", headSha: view.evidence[`cards.${c.id}`].value.headSha ?? null }));
  return { waits: [...waits].map(([id, rows]) => ({ id, num: num.get(id) ?? null, rows })), early };
}

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/repair-false-install-waits.mjs <view.json>   (a dry run: it changes nothing)"); process.exit(2); }
  const { waits, early } = dryRun(JSON.parse(readFileSync(file, "utf8")));
  const lines = [`DRY RUN (nothing is changed): migration 0040 removes ${waits.reduce((n, w) => n + w.rows.length, 0)} install-wait rows on ${waits.length} product cards`];
  for (const w of waits) lines.push(`#C${w.num ?? "?"} ${w.id}: ${w.rows.map((r) => `${r.kind}@${new Date(r.at).toISOString()}`).join(", ")}`);
  lines.push("", `Closed product cards whose stored reading is still ship (${early.length}); the collector re-reads them until each reads live, done_at is untouched:`);
  for (const c of early) lines.push(`#C${c.num ?? "?"} ${c.id}${c.headSha ? ` ${c.headSha.slice(0, 8)}` : ""}`);
  // An optional third argument names a file to write the same list to (for the pack note); the list is printed either way.
  if (process.argv[3]) writeFileSync(process.argv[3], lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}
