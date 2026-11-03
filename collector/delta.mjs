// The Collector reads only what changed (#C642): every 30 minutes its run exports the documents changed since the last
// run, and the probe (collector/state.mjs, every minute) merges that delta into the mirror the gate and the probe read.
// Once a night the run reads the five collections that are edited in place in full, and the probe prints MIRROR DRIFT for
// any difference from the merged mirror before it replaces it. This file is the pure part: what to query, whether an
// export is whole, the merge, the drift. The board filters on data fields only (the system updatedAt is not one), so
// every write to the mutable collections carries its own `updatedAt` (gate/rules.mjs updatedAtErrors, the page's
// applyWrites) and a delete is a tombstone: {deleted: true, updatedAt}.
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_COLLECTIONS } from "./export.mjs";

// Edited in place, with no one time field of their own: they carry updatedAt (a write without it is refused).
export const MUTABLE = ["initiatives", "waiting", "ideas", "threads", "plan"];
// Written whole and once, each document with its own `at`.
export const APPENDED = ["steps", "messages", "ctx"];
// A run asks for a little before the last one began, so a write that landed while it was listing is not lost; the merge
// is idempotent, so a document read twice costs nothing.
export const OVERLAP_MS = 5 * 60e3;
// The nightly full read: due once the last one is a day old, and run in the small hours when the clock allows.
export const FULL_EVERY_MS = 24 * 3600e3;
export const FULL_LATE_MS = 30 * 3600e3;
export const NIGHT_HOURS = [2, 3, 4];
// The mirror's own stamp, inside the mirror folder (a file there is not a collection: readMirror skips it).
export const STAMP_FILE = "_at.json";
export const STEPS_KEEP_DAYS = 7;
const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const DOC = /^[A-Za-z0-9_.@+:~-]{1,200}\.json$/;

// The query field of each delta collection: `at` for the written-once ones, `updatedAt` for the mutable.
export const deltaField = (collection) => (APPENDED.includes(collection) ? "at" : MUTABLE.includes(collection) ? "updatedAt" : null);

// A full read is due when none was made for a day and it is night, or none for 30 hours whatever the hour; always when the
// state or the mirror is missing (nothing to add a delta to).
export function fullDue({ now, fullAt, hasMirror, hour }) {
  if (!hasMirror || !Number.isFinite(fullAt)) return true;
  const age = now - fullAt;
  return age >= FULL_LATE_MS || (age >= FULL_EVERY_MS && NIGHT_HOURS.includes(hour));
}

// What --prepare tells the run: the mode, and for a delta the `since` of the whole run (the last merged run's start less the overlap).
export function deltaPlan({ now, state, hasMirror, hour }) {
  const lastAt = Number.isFinite(state?.at) ? state.at : null;
  const full = lastAt === null || fullDue({ now, fullAt: state?.fullAt, hasMirror, hour });
  if (full) return { mode: "full", since: null, queries: [] };
  const since = Math.max(0, lastAt - OVERLAP_MS);
  return { mode: "delta", since, queries: [...APPENDED, ...MUTABLE].map((collection) => ({ collection, field: deltaField(collection), since })) };
}

// The lines the run reads: one per query (the field and the time written out, so the model types no condition of its own).
export function queryLines(plan) {
  if (plan.mode === "full") return ["Mode: full. Export the board whole, as the steps say."];
  return [`Mode: delta, since ${plan.since}.`, ...plan.queries.map((q) => `Query ${q.collection}: where [["${q.field}", ">=", ${q.since}]]`)];
}

const regular = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
const directory = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };

// An export is whole when its last call landed: the run lists `derived` last, and derived/all.json is there. A full export
// must hold every required collection as well (an empty collection exports no folder, so only these are asked).
export function sealed(exportDir, mode, required = []) {
  if (!regular(join(exportDir, "derived", "all.json"))) return false;
  return mode !== "full" || required.every((c) => directory(join(exportDir, c)));
}

const readDoc = (p) => { try { const d = JSON.parse(readFileSync(p, "utf8")); return d !== null && typeof d === "object" && !Array.isArray(d) ? d : null; } catch { return null; } };
const writeAtomic = (path, text) => { const tmp = `${path}.${process.pid}.part`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path); };

// The documents of one exported collection: [file name, parsed document] for each regular <doc>.json.
function* docsOf(root, collection) {
  const dir = join(root, collection);
  if (!directory(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!DOC.test(f) || !regular(join(dir, f))) continue;
    const d = readDoc(join(dir, f));
    if (d) yield [f, d];
  }
}

export const isTombstone = (collection, d) => MUTABLE.includes(collection) && d.deleted === true;

// Lays a delta export over the mirror: each document replaces its file, a tombstone removes it, and the mirror's stamp
// says what the mirror now holds (changes up to `at`, the run's start). Steps older than STEPS_KEEP_DAYS go. Returns counts.
export function mergeDelta(mirrorDir, exportDir, { at, now, keepDays = STEPS_KEEP_DAYS }) {
  const out = { merged: 0, removed: 0, pruned: 0 };
  for (const c of readdirSync(exportDir)) {
    if (!NAME.test(c) || !EXPORT_COLLECTIONS.includes(c)) continue;
    for (const [f, d] of docsOf(exportDir, c)) {
      const dest = join(mirrorDir, c, f);
      if (isTombstone(c, d)) { if (existsSync(dest)) { rmSync(dest, { force: true }); out.removed++; } continue; }
      mkdirSync(join(mirrorDir, c), { recursive: true });
      writeAtomic(dest, JSON.stringify(d, null, 2));
      out.merged++;
    }
  }
  const cutoff = now - keepDays * 864e5, sdir = join(mirrorDir, "steps");
  if (directory(sdir)) for (const f of readdirSync(sdir)) {
    if (!DOC.test(f)) continue;
    const d = readDoc(join(sdir, f));
    if (d && Number.isFinite(d.at) && d.at < cutoff) { rmSync(join(sdir, f), { force: true }); out.pruned++; }
  }
  writeAtomic(join(mirrorDir, STAMP_FILE), JSON.stringify({ at, mergedAt: now }));
  return out;
}

// What the probe has merged so far, next to the mirror (<dir>/delta-state.json): at = the start of the last run merged
// (the next delta's reference), fullAt = the start of the last full read, lastPrepare = the run it was (so it is merged once).
export const DELTA_STATE_FILE = "delta-state.json";
export function readDeltaState(dir) {
  const s = readDoc(join(dir, DELTA_STATE_FILE));
  return s && Number.isFinite(s.at) ? { at: s.at, fullAt: Number.isFinite(s.fullAt) ? s.fullAt : null, lastPrepare: Number.isFinite(s.lastPrepare) ? s.lastPrepare : null } : null;
}
export function writeDeltaState(dir, state) { writeAtomic(join(dir, DELTA_STATE_FILE), JSON.stringify(state)); }

export function readStamp(mirrorDir) {
  const s = readDoc(join(mirrorDir, STAMP_FILE));
  return s && Number.isFinite(s.at) ? { at: s.at, mergedAt: Number.isFinite(s.mergedAt) ? s.mergedAt : s.at } : null;
}
export function writeStamp(mirrorDir, at, mergedAt) { writeAtomic(join(mirrorDir, STAMP_FILE), JSON.stringify({ at, mergedAt })); }

function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
}

// The nightly check: the five mutable collections of a full export against the mirror the deltas built. Returns the DRIFT
// lines (none when they agree). A document written after the mirror's stamp is no drift (the full read is newer than the
// mirror, and a stamped write is how the deltas would have caught it): only a difference no stamp explains is.
export function driftLines(mirrorDir, fullDir, { cap = 5 } = {}) {
  const stamp = readStamp(mirrorDir)?.at ?? 0;
  const lines = [];
  for (const c of MUTABLE) {
    const board = new Map([...docsOf(fullDir, c)].map(([f, d]) => [f, d]));
    const mine = new Map([...docsOf(mirrorDir, c)].map(([f, d]) => [f, d]));
    const changed = [], missed = [], gone = [];
    for (const [f, d] of board) {
      const m = mine.get(f);
      const fresh = Number.isFinite(d.updatedAt) && d.updatedAt > stamp;
      if (d.deleted === true) { if (m) gone.push(f); continue; }
      if (!m) { if (!fresh) missed.push(f); continue; }
      if (!deepEq(d, m) && !fresh) changed.push(f);
    }
    for (const [f, m] of mine) if (!board.has(f) && !m.deleted) gone.push(f);
    const name = (list) => `${list.length} (${list.slice(0, cap).map((f) => f.slice(0, -5)).join(", ")}${list.length > cap ? ", …" : ""})`;
    const parts = [];
    if (changed.length) parts.push(`changed with no newer updatedAt ${name(changed)}`);
    if (missed.length) parts.push(`created and never seen ${name(missed)}`);
    if (gone.length) parts.push(`deleted on the board, still in the mirror ${name(gone)}`);
    if (parts.length) lines.push(`MIRROR DRIFT ${c}: ${parts.join("; ")}. The deltas did not catch it: a write without updatedAt, or a hard delete.`);
  }
  return lines;
}

// The derive step (#C642): collector/collect.mjs --from-mirror, run by the probe when a merge changed the mirror or every
// DERIVE_EVERY_MS (the repository moves without the board). It writes derived-all.json for the Collector to publish and
// prints the lines for the lead, which go to collector-lines.json for the lead's watch (gate/reset.mjs LINES_FILE).
export const DERIVE_EVERY_MS = 10 * 60e3;
export const DERIVE_FILE = "derive-run.json";
export const LINE_START = /^(CONFLICT|LIVE BUT OPEN|NUDGE|KEEPER|MIRROR DRIFT)\b/;
export function deriveDue({ merged, last, now, outExists }) {
  return Boolean(merged) || !outExists || !Number.isFinite(last) || now - last >= DERIVE_EVERY_MS || last > now + 60e3;
}
export const deriveLines = (stdout) => String(stdout ?? "").split("\n").filter((l) => LINE_START.test(l));
export function saveLines(dir, lines, now) {
  if (!lines.length) return false;
  writeAtomic(join(dir, "collector-lines.json"), JSON.stringify({ at: now, lines }));
  return true;
}

