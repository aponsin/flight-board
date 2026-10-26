// Numbers the board's cards (#C1, #C2, ...) in the order they were made, like scripts/thread-ids.mjs does for threads.
// Usage: node scripts/card-ids.mjs <export folder> [out folder] [--days <n>]
// The export folder holds an ArtifactData export (out_dir) of the board's `initiatives` and `meta` collections. Cards
// still open, and those closed in the last <n> days (30 by default), get the next numbers; older closed cards stay
// unnumbered. It writes batch-1.json, ... (each at most 50 writes: the cards it numbers and meta/cardSeq), to send in
// order with ArtifactData batch, meta/cardSeq pinned with if_version to the version a get just read (none the first
// time). Cards that have a number keep it. A new card takes its number when it is made: num = meta/cardSeq's next, and
// the counter moved in the same batch.
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_SEQ } from "../gate/rules.mjs";
import { readCollection } from "./thread-ids.mjs";
const BATCH = 49;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// cards: [{ id, num?, status, createdAt?, doneAt? }]; seq: { next } or null; now (ms); days.
// Returns { batches, first, next }.
export function allocate({ cards = [], seq = null, now = Date.now(), days = 30 }) {
  const valid = cards.filter((k) => k && typeof k.id === "string");
  const numbered = valid.filter((k) => Number.isInteger(k.num) && k.num > 0);
  const first = Math.max(Number.isInteger(seq?.next) ? seq.next : 1, ...numbered.map((k) => k.num + 1), 1);
  const shut = (k) => k.status === "done" || k.status === "dropped";
  const recent = (k) => !shut(k) || (num(k.doneAt) != null && now - k.doneAt <= days * 864e5);
  const made = (k) => num(k.createdAt) ?? num(k.doneAt) ?? Infinity;
  const todo = valid.filter((k) => !numbered.includes(k) && recent(k)).sort((a, b) => made(a) - made(b) || (a.id < b.id ? -1 : 1)).map((k) => k.id);
  const batches = [];
  let n = first;
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH).map((id) => ({ op: "update", collection: "initiatives", doc_id: id, data: { num: n++ } }));
    part.push({ op: seq || batches.length ? "update" : "set", collection: "meta", doc_id: CARD_SEQ, data: { next: n } });
    batches.push(part);
  }
  return { batches, first, next: n };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--days");
  const days = at >= 0 ? Number(args[at + 1]) : 30;
  const [dir, out = dir] = args.filter((a, i) => a !== "--days" && args[i - 1] !== "--days");
  if (!dir || !(days > 0)) { console.error("Usage: node scripts/card-ids.mjs <export folder> [out folder] [--days <n>]"); process.exit(2); }
  const seq = readCollection(dir, "meta").find((d) => d.id === CARD_SEQ) ?? null;
  const { batches, first, next } = allocate({ cards: readCollection(dir, "initiatives"), seq, days });
  mkdirSync(out, { recursive: true });
  batches.forEach((b, k) => writeFileSync(join(resolve(out), `card-batch-${k + 1}.json`), JSON.stringify(b, null, 2) + "\n"));
  console.log(batches.length ? `Numbers #C${first} to #C${next - 1} in ${batches.length} batch(es): ${batches.map((_, k) => `card-batch-${k + 1}.json`).join(", ")}. Send each with ArtifactData batch, meta/${CARD_SEQ} pinned to the version a get just read${seq ? "" : " (none for the first)"}.` : "Every open and recent card has its number.");
}
