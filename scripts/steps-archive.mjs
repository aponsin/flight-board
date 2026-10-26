// Archives the steps of cards closed a while ago (#C210): the lead's tool, never the page's. The steps collection grew
// by every start and end and never shrank, and the page and every collector run read all of it.
// Usage: node scripts/steps-archive.mjs <export folder> [out folder] [--days 1]
// The export folder holds an ArtifactData export (out_dir) of the board's `initiatives`, `steps` (all of them, no "at"
// filter) and `timings`. For each card done or dropped at least --days ago, it sets `timings/<card id>` {steps, at}: the
// card's steps, kept as they were (the archive). Then it deletes from `steps` only the steps that timings document
// holds. The page reads a closed card's steps from both places (each step once, by its id), so a step logged after
// the archive (a late end) stays in `steps` and still counts; the next run leaves it there too. Files batch-1.json,
// batch-2.json, ... (at most 49 writes each), sent in order with ArtifactData batch: a card's timings come before its
// first delete, so a stop between batches loses nothing (run it again: it only deletes what is archived). Only the
// lead may write timings or delete steps (the gate).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const BATCH = 49;
const DAY = 864e5;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// cards: [{ id, status, doneAt? }]; steps: [{ id, init, ... }]; timings: [{ id, steps: [{ id, ... }] }].
// Returns { batches: [[write]], ids: [card ids archived or cleared], late: [step ids kept back] }.
export function plan({ cards, steps, timings = [], now, days = 1, livePhase = "live" }) {
  const byCard = new Map();
  for (const s of steps) if (s && typeof s.id === "string" && typeof s.init === "string") (byCard.get(s.init) ?? byCard.set(s.init, []).get(s.init)).push(s);
  const archived = new Map(timings.filter((t) => t && typeof t.id === "string").map((t) => [t.id, new Set((Array.isArray(t.steps) ? t.steps : []).map((x) => x && x.id))]));
  const writes = [], ids = [], late = [];
  for (const card of cards) {
    if (!card || (card.status !== "done" && card.status !== "dropped")) continue;
    const mine = (byCard.get(card.id) ?? []).sort((x, y) => (num(x.at) ?? 0) - (num(y.at) ?? 0) || (x.id < y.id ? -1 : 1));
    if (!mine.length) continue;
    const liveAt = mine.find((x) => x.phase === livePhase && num(x.at) != null)?.at;
    const closedAt = num(card.doneAt) ?? liveAt ?? Math.max(...mine.map((x) => num(x.at) ?? 0));
    if (now - closedAt < days * DAY) continue;
    let gone = mine;
    if (archived.has(card.id)) {
      const kept = archived.get(card.id);
      gone = mine.filter((x) => kept.has(x.id));
      late.push(...mine.filter((x) => !kept.has(x.id)).map((x) => x.id));
    } else {
      writes.push({ op: "set", collection: "timings", doc_id: card.id, data: { steps: mine, at: now } });
    }
    if (!gone.length) continue;
    ids.push(card.id);
    for (const x of gone) writes.push({ op: "delete", collection: "steps", doc_id: x.id });
  }
  const batches = [];
  for (let k = 0; k < writes.length; k += BATCH) batches.push(writes.slice(k, k + BATCH));
  return { batches, ids, late };
}

// A collection from an ArtifactData export: [{ id, ...data }], or [] when it wasn't exported.
export function readCollection(dir, name) {
  const d = join(dir, name);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => ({ id: f.slice(0, -5), ...JSON.parse(readFileSync(join(d, f), "utf8")) }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--days");
  const days = at >= 0 ? Number(args.splice(at, 2)[1]) : 1;
  const [dir, out = dir] = args;
  if (!dir || !(days >= 0)) { console.error("Usage: node scripts/steps-archive.mjs <export folder> [out folder] [--days 1]"); process.exit(2); }
  const { batches, ids, late } = plan({ cards: readCollection(dir, "initiatives"), steps: readCollection(dir, "steps"), timings: readCollection(dir, "timings"), now: Date.now(), days });
  mkdirSync(out, { recursive: true });
  batches.forEach((b, k) => writeFileSync(join(resolve(out), `batch-${k + 1}.json`), JSON.stringify(b, null, 2) + "\n"));
  console.log(ids.length ? `Archives the steps of ${ids.length} closed card(s) in ${batches.length} batch(es): ${batches.map((_, k) => `batch-${k + 1}.json`).join(", ")}. Send each in order with ArtifactData batch.` : "No closed card has steps to archive.");
  if (late.length) console.log(`${late.length} step(s) logged after their card was archived stay in steps (the page counts them): ${late.join(", ")}`);
}
