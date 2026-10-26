// Archives the steps of cards closed a while ago (#C210): the lead's tool, never the page's. The steps collection grew
// by every start and end and never shrank, and the page and every collector run read all of it.
// Usage: node scripts/steps-archive.mjs <export folder> [out folder] [--days 1]
// The export folder holds an ArtifactData export (out_dir) of the board's `initiatives`, `steps` (all of them, no "at"
// filter) and `timings`. For each card done or dropped at least --days ago, it writes `timings/<card id>`: the card's
// phase entries (its steps paired as the page pairs them), doneAt, version and shipDetail from its live step, and the
// steps themselves (the archive); then it deletes those steps from `steps`. The page reads a card's timings instead of
// its steps once they exist. Files batch-1.json, batch-2.json, ... (at most 49 writes each), sent in order with
// ArtifactData batch: a card's timings come before its first delete, so a stop between batches loses nothing (run it
// again: a card that has its timings only gets its remaining deletes).
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const BATCH = 49;
const DAY = 864e5;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The page's pairing of start and end events into phase entries (fromSteps in page/board.template.html), and what a
// live event carries. steps: one card's, any order. Returns { log, live: { at, version?, shipDetail? } | null }.
export function phaseLog(steps, livePhase = "live") {
  const evs = steps.filter((e) => e && e.phase && num(e.at) != null).sort((a, b) => a.at - b.at);
  const log = [], open = {};
  let live = null;
  for (const e of evs) {
    const key = `${e.phase}|${e.who || ""}|${e.wait || ""}`;
    if (e.phase === livePhase) {
      live = { at: e.at };
      if (e.version) live.version = e.version;
      if (num(e.testsMin) != null || num(e.deployMin) != null) live.shipDetail = [num(e.testsMin) != null ? `tests ${Math.round(e.testsMin)} min` : "", num(e.deployMin) != null ? `deploy ${Math.round(e.deployMin)} min` : ""].filter(Boolean).join(" · ");
      continue;
    }
    if (e.kind === "end") { const o = open[key]; if (o) { o.end = e.at; delete open[key]; } else log.push({ phase: e.phase, who: e.who, start: e.at, end: e.at }); continue; }
    if (open[key] && open[key].end == null) open[key].end = e.at;
    const en = { phase: e.phase, who: e.who, start: e.at };
    if (e.wait) en.wait = e.wait;
    log.push(en);
    open[key] = en;
  }
  return { log, live };
}

// cards: [{ id, status, doneAt? }]; steps: [{ id, init, ... }]; timings: [{ id }] (the cards that have theirs).
// Returns { batches: [[write]], ids: [card ids] }.
export function plan({ cards, steps, timings = [], now, days = 1, livePhase = "live" }) {
  const byCard = new Map();
  for (const s of steps) if (s && typeof s.id === "string" && typeof s.init === "string") (byCard.get(s.init) ?? byCard.set(s.init, []).get(s.init)).push(s);
  const have = new Set(timings.map((t) => t && t.id));
  const writes = [], ids = [];
  for (const card of cards) {
    if (!card || (card.status !== "done" && card.status !== "dropped")) continue;
    const mine = (byCard.get(card.id) ?? []).sort((x, y) => (num(x.at) ?? 0) - (num(y.at) ?? 0) || (x.id < y.id ? -1 : 1));
    if (!mine.length) continue;
    const { log, live } = phaseLog(mine, livePhase);
    const closedAt = num(card.doneAt) ?? live?.at ?? Math.max(...mine.map((s) => num(s.at) ?? 0));
    if (now - closedAt < days * DAY) continue;
    ids.push(card.id);
    if (!have.has(card.id)) {
      const data = { phaseLog: log, steps: mine.map(({ id, ...rest }) => ({ id, ...rest })), at: now };
      if (live) { data.live = true; data.doneAt = live.at; if (live.version) data.version = live.version; if (live.shipDetail) data.shipDetail = live.shipDetail; }
      writes.push({ op: "set", collection: "timings", doc_id: card.id, data });
    }
    for (const s of mine) writes.push({ op: "delete", collection: "steps", doc_id: s.id });
  }
  const batches = [];
  for (let k = 0; k < writes.length; k += BATCH) batches.push(writes.slice(k, k + BATCH));
  return { batches, ids };
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
  const { batches, ids } = plan({ cards: readCollection(dir, "initiatives"), steps: readCollection(dir, "steps"), timings: readCollection(dir, "timings"), now: Date.now(), days });
  mkdirSync(out, { recursive: true });
  batches.forEach((b, k) => writeFileSync(join(resolve(out), `batch-${k + 1}.json`), JSON.stringify(b, null, 2) + "\n"));
  console.log(ids.length ? `Archives the steps of ${ids.length} closed card(s) in ${batches.length} batch(es): ${batches.map((_, k) => `batch-${k + 1}.json`).join(", ")}. Send each in order with ArtifactData batch.` : "No closed card has steps to archive.");
}
