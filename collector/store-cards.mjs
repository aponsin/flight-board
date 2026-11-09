// The evidence job's cards come from the STORE (#C719), not from the old board's mirror. collector/state.mjs (a pinned file, left
// as it is) reads its card list from <stateDir>/<board id>/mirror/initiatives/<id>.json. So the probe keeps a private state
// directory of its own, writes the store's open cards there in that shape, and points a copy of the board config at it
// (gate.stateDir). The Collector's merge, which state.mjs calls first, finds no deltas in that directory and changes nothing,
// and the old board's mirror is never read or written. Everything here is plain functions and one fetch; no secrets are written.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, copyFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { FETCH_TIMEOUT_MS } from "./probe-board.mjs";

const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const num = (v) => (Number.isFinite(v) ? v : undefined);
const str = (v) => (typeof v === "string" && v !== "" ? v : undefined);

// A store card as the mirror's initiative document (the shape the old board kept and state.mjs reads). Nothing is invented: a
// field the store does not have is left out, and the status is only what the store's flags say.
export function mirrorCard(c) {
  const d = {
    name: str(c.title), summary: str(c.summary), who: str(c.owner_role), size: str(c.size), level: str(c.review_level),
    num: num(c.num), nextNote: str(c.next_note), nextNoteAt: num(c.next_note_at), waitingOn: str(c.waiting_on), phaseReason: str(c.rework_reason),
    createdAt: num(c.created_at), updatedAt: num(c.updated_at),
    status: c.dropped ? "dropped" : c.paused ? "paused" : "active",
  };
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
}

// The store's open cards, from its own typed read as the probe.
export async function storeCards({ base, headers, fetchImpl = fetch }) {
  const r = await fetchImpl(`${base}/api/view`, { headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`view answered ${r.status}`);
  const v = await r.json();
  if (!Array.isArray(v?.cards)) throw new Error("view has no cards");
  return v.cards.filter((c) => c && CARD_ID.test(String(c.id)));
}

// Writes <dir>/<id>/mirror/initiatives/<card>.json for every card and removes the ones the store no longer has, then stamps the
// mirror (_at.json) with the time of this read. Each file is written whole under a temporary name and renamed into place.
export function syncMirror({ cards, dir, boardId, now }) {
  const mdir = join(dir, boardId, "mirror", "initiatives");
  mkdirSync(mdir, { recursive: true });
  const keep = new Set();
  for (const c of cards) {
    const f = join(mdir, `${c.id}.json`), tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(mirrorCard(c)), { mode: 0o600 });
    renameSync(tmp, f);
    keep.add(`${c.id}.json`);
  }
  let removed = 0;
  for (const f of readdirSync(mdir)) if (f.endsWith(".json") && !keep.has(f)) { rmSync(join(mdir, f)); removed++; }
  writeFileSync(join(dir, boardId, "mirror", "_at.json"), JSON.stringify({ at: now }), { mode: 0o600 });
  return { written: keep.size, removed };
}

// A copy of the board config with its state directory moved to the private one; nothing else in it changes.
export function privateConfig(raw, dir) {
  return { ...raw, gate: { ...(raw?.gate ?? {}), stateDir: dir } };
}

// Everything the evidence job needs before it builds the state from the store's cards: the mirror, the private config, the
// seeded usage history. Returns where to point state.mjs (--config) and where it leaves its state.json.
// `stateFile` is the old location (<dir>/<board id>/state.json); only its board id and its usage history are used.
export async function prepareStoreState({ privateDir, stateFile, configPath, base, headers, fetchImpl = fetch, now = Date.now(), readText = (p) => readFileSync(p, "utf8"), log = () => {} }) {
  const boardId = basename(dirname(stateFile));
  if (!/^[A-Za-z0-9]{6,64}$/.test(boardId)) throw new Error("the state path has no board id");
  const cards = await storeCards({ base, headers, fetchImpl });
  const m = syncMirror({ cards, dir: privateDir, boardId, now });
  const seeded = seedUsage({ from: dirname(stateFile), to: join(privateDir, boardId) });
  const cfgPath = join(privateDir, boardId, "config.json");
  writeFileSync(cfgPath, JSON.stringify(privateConfig(JSON.parse(readText(configPath)), privateDir)), { mode: 0o600 });
  log(`store cards: ${m.written} written, ${m.removed} removed${seeded ? `, ${seeded} usage file(s) seeded` : ""}`);
  return { configPath: cfgPath, stateFile: join(privateDir, boardId, "state.json") };
}

// The first time only: the usage history the old state job keeps is copied over, so the usage tile does not start from nothing.
export function seedUsage({ from, to }) {
  mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const f of ["usage.json", "usage-plan.json"]) if (existsSync(join(from, f)) && !existsSync(join(to, f))) { copyFileSync(join(from, f), join(to, f)); copied++; }
  return copied;
}
