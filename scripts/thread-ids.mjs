// Numbers the board's threads (#T1, #T2, ...) in the order they were opened: the lead's tool, never the page's.
// Usage: node scripts/thread-ids.mjs <export folder> [out folder]
// The export folder holds an ArtifactData export (out_dir) of the board's `messages`, `waiting`, `threads` and `meta`
// collections. Every waiting item is a thread too (opened at its since), so none shows without its #T (thread-num-always),
// and every thread gets a title (the item's text, or its first message's) where it has none.
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

const TITLE_MAX = 120;
const titleOf = (text) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t; };

// threads: [{ id, num?, title? }]; messages: [{ thread, at, text? }]; waiting: [{ id, since, text? }]; seq: { next } or null.
// Returns { batches: [[write]], first, next }: each write { op, collection, doc_id, data }.
export function allocate({ threads = [], messages = [], waiting = [], seq = null }) {
  const have = new Map(threads.filter((t) => t && typeof t.id === "string").map((t) => [t.id, t]));
  const numbered = [...have.values()].filter((t) => Number.isInteger(t.num) && t.num > 0);
  const first = Math.max(Number.isInteger(seq?.next) ? seq.next : 1, ...numbered.map((t) => t.num + 1), 1);
  const opened = new Map();
  const named = new Map(); // each thread's title source: the item's text, else its first message's
  const open = (id, at, text, first) => {
    if (!opened.has(id) || at < opened.get(id)) { opened.set(id, at); if (!first || !named.has(id)) named.set(id, text); }
  };
  for (const w of waiting) if (w && typeof w.id === "string" && w.id && typeof w.since === "number") { opened.set(w.id, Math.min(opened.get(w.id) ?? Infinity, w.since)); named.set(w.id, w.text); }
  for (const m of messages) {
    if (!m || typeof m.thread !== "string" || !m.thread || typeof m.at !== "number") continue;
    open(m.thread, m.at, m.text, true);
  }
  const hasTitle = (id) => typeof have.get(id)?.title === "string" && have.get(id).title.trim() !== "";
  const title = (id) => (hasTitle(id) ? {} : titleOf(named.get(id)) ? { title: titleOf(named.get(id)) } : {});
  const todo = [...opened].filter(([id]) => !numbered.some((t) => t.id === id)).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  // Numbered threads with no title get one, their number untouched.
  const untitled = numbered.filter((t) => !hasTitle(t.id) && titleOf(named.get(t.id))).map((t) => ({ op: "update", collection: "threads", doc_id: t.id, data: title(t.id) }));
  const batches = untitled.length ? [untitled.slice(0, BATCH)] : [];
  for (let k = BATCH; k < untitled.length; k += BATCH) batches.push(untitled.slice(k, k + BATCH));
  let n = first;
  for (let k = 0; k < todo.length; k += BATCH) {
    const part = todo.slice(k, k + BATCH).map((id) => ({ op: have.has(id) ? "update" : "set", collection: "threads", doc_id: id, data: { num: n++, ...title(id) } }));
    const seqExists = !!seq || batches.some((b) => b.some((w) => w.collection === "meta"));
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
  const { batches, first, next } = allocate({ threads: readCollection(dir, "threads"), messages: readCollection(dir, "messages"), waiting: readCollection(dir, "waiting"), seq });
  mkdirSync(out, { recursive: true });
  batches.forEach((b, k) => writeFileSync(join(resolve(out), `batch-${k + 1}.json`), JSON.stringify(b, null, 2) + "\n"));
  console.log(batches.length ? `Numbers #T${first} to #T${next - 1} in ${batches.length} batch(es): ${batches.map((_, k) => `batch-${k + 1}.json`).join(", ")}. Send each with ArtifactData batch, meta/${THREAD_SEQ} pinned to the version a get just read${seq ? "" : " (none for the first)"}.` : "Every thread has its number.");
}
