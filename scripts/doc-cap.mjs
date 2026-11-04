// Keeps the board under its document cap (#C646). The board database holds at most 25,000 documents and steps and messages only
// grow. This is the lead's tool, never the page's or an agent's, and it deletes nothing by itself: it reads the collector's
// mirror and prints what it WOULD archive (dry), or writes the db_write batches that do it, for the lead to send one at a time
// after the owner's yes on the dry numbers.
//   node scripts/doc-cap.mjs dry <mirror folder> [--days 14]
//   node scripts/doc-cap.mjs steps <mirror folder> <out folder> [--days 14]        (A: steps of closed cards -> timings/<card>)
//   node scripts/doc-cap.mjs messages <mirror folder> <out folder> [--days 14]     (B: messages of quiet threads -> a local file)
//   node scripts/doc-cap.mjs restore <archive file> <out folder>                   (puts a messages archive back)
// Rules: only closed cards' steps; only threads silent for --days and tied to nothing open (no open ask and no card that is not
// done names the thread); a message archive is written to the out folder BEFORE any delete batch, byte for byte as the mirror
// holds it, and the delete batches carry ifVersion 1 (these documents are written once; a changed one is refused, so the batch
// fails whole and nothing is lost). Archives of steps stay on the board (timings/<card>, #C210: the page reads both); archives of
// messages leave a line, timings/thread-<id> {archivedMessages, from, to, archivedAt}, for the page to say "N older messages
// archived". The documents freed are the deletes minus the documents this adds.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plan as stepsPlan, readCollection } from "./steps-archive.mjs";

export const BATCH = 49, DAY = 864e5, DAYS = 14, OPS_PER_DAY = 731;
const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// A: the steps of cards closed `days` ago, as db_write ops. Returns { ops: [[op]], cards, deleted, added, freed, late }.
export function planSteps({ cards, steps, timings = [], now, days = DAYS }) {
  const p = stepsPlan({ cards, steps, timings, now, days });
  const ops = p.batches.map((b) => b.map((w) => (w.op === "set" ? { op: "set", path: `${w.collection}/${w.doc_id}`, data: w.data } : { op: "delete", path: `${w.collection}/${w.doc_id}`, ifVersion: 1 })));
  const flat = ops.flat();
  const deleted = flat.filter((o) => o.op === "delete").length, added = flat.filter((o) => o.op === "set").length;
  return { ops, cards: p.ids.length, deleted, added, freed: deleted - added, late: p.late };
}

// B: the messages of threads silent for `days` and tied to nothing open. messages: [{ id, thread, at, ... }], threads, waiting,
// cards: the mirror's documents ({ id, ...data }). Returns { archive: { threadId: [doc] }, threads, deleted, added, freed, kept }.
export function planMessages({ messages, waiting = [], cards = [], now, days = DAYS }) {
  const byThread = new Map();
  for (const m of messages) if (m && typeof m.id === "string" && THREAD_ID.test(m.id) && typeof m.thread === "string" && THREAD_ID.test(m.thread)) (byThread.get(m.thread) ?? byThread.set(m.thread, []).get(m.thread)).push(m);
  const open = [...waiting.filter((w) => w && w.done !== true), ...cards.filter((c) => c && c.status !== "done" && c.status !== "dropped")].map((d) => JSON.stringify(d));
  const archive = {}, kept = { recent: 0, tied: 0 };
  for (const [tid, list] of byThread) {
    const newest = Math.max(...list.map((m) => num(m.at) ?? 0));
    if (!newest || now - newest < days * DAY) { kept.recent++; continue; }
    if (open.some((s) => s.includes(tid))) { kept.tied++; continue; }
    archive[tid] = list.sort((a, b) => (num(a.at) ?? 0) - (num(b.at) ?? 0) || (a.id < b.id ? -1 : 1));
  }
  const threads = Object.keys(archive).sort();
  const deleted = threads.reduce((n, t) => n + archive[t].length, 0);
  return { archive, threads, deleted, added: threads.length, freed: deleted - threads.length, kept };
}

// The db_write ops for B, after the archive file exists: the thread's line first, then the deletes (a card's line comes before its
// first delete, so a stop between batches loses nothing: run it again).
export function messageOps(plan, now) {
  const writes = [];
  for (const tid of plan.threads) {
    const list = plan.archive[tid];
    writes.push({ op: "set", path: `timings/thread-${tid}`, data: { archivedMessages: list.length, from: num(list[0].at), to: num(list.at(-1).at), archivedAt: now } });
    for (const m of list) writes.push({ op: "delete", path: `messages/${m.id}`, ifVersion: 1 });
  }
  const batches = [];
  for (let k = 0; k < writes.length; k += BATCH) batches.push(writes.slice(k, k + BATCH));
  return batches;
}

// The ops that put an archive back: every message as it was (a set of a missing document needs no version) and the line removed.
export function restoreOps(file) {
  const writes = [];
  for (const [tid, list] of Object.entries(file?.threads ?? {})) {
    for (const m of list) { const { id, ...data } = m; writes.push({ op: "set", path: `messages/${id}`, data }); }
    writes.push({ op: "delete", path: `timings/thread-${tid}`, ifVersion: 1 });
  }
  const batches = [];
  for (let k = 0; k < writes.length; k += BATCH) batches.push(writes.slice(k, k + BATCH));
  return batches;
}

export function dryReport({ cards, steps, timings, messages, waiting, now, days = DAYS }) {
  const a = planSteps({ cards, steps, timings, now, days }), b = planMessages({ messages, waiting, cards, now, days });
  const freed = a.freed + b.freed;
  return [
    `Dry list (nothing is written), cut at ${days} days:`,
    `A. steps of closed cards: ${a.cards} card(s), ${a.deleted} steps deleted, ${a.added} timings added, ${a.freed} documents freed`,
    `B. messages of quiet threads: ${b.threads.length} thread(s), ${b.deleted} messages archived to a file and deleted, ${b.added} lines added, ${b.freed} documents freed (kept: ${b.kept.recent} recent, ${b.kept.tied} tied to something open)`,
    `Total freed: ${freed} documents, about ${(freed / OPS_PER_DAY).toFixed(1)} days of growth at ${OPS_PER_DAY} a day.`,
  ].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--days");
  const days = at >= 0 ? Number(args.splice(at, 2)[1]) : DAYS;
  const [cmd, dir, out] = args;
  const now = Date.now();
  const read = (c) => readCollection(dir, c);
  const write = (name, v) => writeFileSync(join(resolve(out), name), JSON.stringify(v, null, 2) + "\n");
  const usage = () => { console.error("Usage: node scripts/doc-cap.mjs dry <mirror> | steps <mirror> <out> | messages <mirror> <out> | restore <archive file> <out>  [--days 14]"); process.exit(2); };
  if (!cmd || !dir || !(days >= 0)) usage();
  if (cmd === "dry") {
    console.log(dryReport({ cards: read("initiatives"), steps: read("steps"), timings: read("timings"), messages: read("messages"), waiting: read("waiting"), now, days }));
  } else if (cmd === "steps" && out) {
    const p = planSteps({ cards: read("initiatives"), steps: read("steps"), timings: read("timings"), now, days });
    mkdirSync(out, { recursive: true });
    p.ops.forEach((b, k) => write(`steps-batch-${k + 1}.json`, b));
    console.log(`${p.cards} card(s), ${p.ops.length} batch(es) of db_write ops in ${out}, ${p.freed} documents freed. Send each in order, one db_write at a time.`);
  } else if (cmd === "messages" && out) {
    const p = planMessages({ messages: read("messages"), waiting: read("waiting"), cards: read("initiatives"), now, days });
    if (!p.threads.length) { console.log("No quiet thread to archive."); process.exit(0); }
    mkdirSync(out, { recursive: true });
    const file = `messages-archive-${now}.json`;
    write(file, { archivedAt: now, days, threads: Object.fromEntries(p.threads.map((t) => [t, p.archive[t].map(({ id, ...data }) => ({ id, ...data }))])) });
    const batches = messageOps(p, now);
    batches.forEach((b, k) => write(`messages-batch-${k + 1}.json`, b));
    console.log(`${p.threads.length} thread(s), ${p.deleted} messages. The archive is ${join(resolve(out), file)} (written first: keep it); ${batches.length} batch(es) of db_write ops, ${p.freed} documents freed. Send each in order, one db_write at a time.`);
  } else if (cmd === "restore" && out) {
    const file = JSON.parse(readFileSync(dir, "utf8"));
    mkdirSync(out, { recursive: true });
    restoreOps(file).forEach((b, k) => write(`restore-batch-${k + 1}.json`, b));
    console.log(`Restore batches written to ${out}.`);
  } else usage();
}
