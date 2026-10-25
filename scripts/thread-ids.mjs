// Numbers the board's threads (#T1, #T2, ...) in the order they were opened: the lead's tool, never the page's.
// Usage: node scripts/thread-ids.mjs <export folder> [out folder]
// The export folder holds an ArtifactData export (out_dir) of the board's `messages`, `threads` and `meta` collections.
// It writes batch-1.json, batch-2.json, ... (each at most 50 writes: the threads it numbers and meta/threadSeq), to send
// in order with ArtifactData batch, the meta/threadSeq entry pinned with if_version to the version a get just read (none
// the first time). A pinned batch is all or nothing, so two allocations can't hand out the same number; if the pin fails,
// export again and rerun. Threads that already have a number keep it.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THREAD_SEQ } from "../gate/rules.mjs";
const BATCH = 49;

// threads: [{ id, num?, title? }]; messages: [{ thread, at }]; seq: { next } or null.
// Returns { batches: [[write]], first, next }: each write { op, collection, doc_id, data }.
export function allocate({ threads = [], messages = [], seq = null }) {
  const have = new Map(threads.filter((t) => t && typeof t.id === "string").map((t) => [t.id, t]));
  const numbered = [...have.values()].filter((t) => Number.isInteger(t.num) && t.num > 0);
  const first = Math.max(Number.isInteger(seq?.next) ? seq.next : 1, ...numbered.map((t) => t.num + 1), 1);
  const opened = new Map();
  for (const m of messages) {
    if (!m || typeof m.thread !== "string" || !m.thread || typeof m.at !== "number") continue;
    if (!opened.has(m.thread) || m.at < opened.get(m.thread)) opened.set(m.thread, m.at);
  }
  const todo = [...opened].filter(([id]) => !numbered.some((t) => t.id === id)).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  const batches = [];
  let n = first;
  for (let k = 0; k < todo.length; k += BATCH) {
    const part = todo.slice(k, k + BATCH).map((id) => ({ op: have.has(id) ? "update" : "set", collection: "threads", doc_id: id, data: { num: n++ } }));
    const seqExists = !!seq || batches.length > 0;
    part.push({ op: seqExists ? "update" : "set", collection: "meta", doc_id: THREAD_SEQ, data: { next: n } });
    batches.push(part);
  }
  return { batches, first, next: n };
}

// A collection from an ArtifactData export: [{ id, ...data }], or [] when it wasn't exported.
export function readCollection(dir, name) {
  const d = join(dir, name);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => ({ id: f.slice(0, -5), ...JSON.parse(readFileSync(join(d, f), "utf8")) }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [dir, out = dir] = process.argv.slice(2);
  if (!dir) { console.error("Usage: node scripts/thread-ids.mjs <export folder> [out folder]"); process.exit(2); }
  const seq = readCollection(dir, "meta").find((d) => d.id === THREAD_SEQ) ?? null;
  const { batches, first, next } = allocate({ threads: readCollection(dir, "threads"), messages: readCollection(dir, "messages"), seq });
  mkdirSync(out, { recursive: true });
  batches.forEach((b, k) => writeFileSync(join(resolve(out), `batch-${k + 1}.json`), JSON.stringify(b, null, 2) + "\n"));
  console.log(batches.length ? `Numbers #T${first} to #T${next - 1} in ${batches.length} batch(es): ${batches.map((_, k) => `batch-${k + 1}.json`).join(", ")}. Send each with ArtifactData batch, meta/${THREAD_SEQ} pinned to the version a get just read${seq ? "" : " (none for the first)"}.` : "Every thread has its number.");
}
