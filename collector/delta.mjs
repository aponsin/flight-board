// The Collector reads only what changed (#C642): every 30 minutes its run exports the documents changed since the last
// run, and the probe (collector/state.mjs, every minute) merges that delta into the mirror the gate and the probe read.
// Once a night the run reads the five collections that are edited in place in full, and the probe prints MIRROR DRIFT for
// any difference from the merged mirror before it replaces it. This file is the pure part: what to query, whether an
// export is whole, the merge, the drift. The board filters on data fields only (the system updatedAt is not one), so
// every write to the mutable collections carries its own `updatedAt` (gate/rules.mjs updatedAtErrors, the page's
// applyWrites) and a delete is a tombstone: {deleted: true, updatedAt}.
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_COLLECTIONS, CURSOR } from "./export.mjs";

// Edited in place, with no one time field of their own: they carry updatedAt (a write without it is refused).
export const MUTABLE = ["initiatives", "waiting", "ideas", "threads", "plan"];
// Written whole and once, each document with its own `at`.
export const APPENDED = ["steps", "messages", "ctx"];
// A run asks for a little before the last one began, so a write that landed while it was listing is not lost; the merge
// is idempotent, so a document read twice costs nothing.
export const OVERLAP_MS = 5 * 60e3;
// The sweep (#C655): the app's board tools return every document into the run, so the whole board is read one page at a
// time, one page per run, never in one go. A sweep goes through these collections in order, each page at most `limit`
// documents (about 100 KB: a run stays under 100k tokens with the copy it writes); `since` marks the one read by its
// own `at`. It collects into a staging folder (<state>/sweep) that replaces the mirror when the last page is in, after
// the MIRROR DRIFT check. A new sweep starts when the last is SWEEP_CYCLE_MS old (at once when there is no mirror); once
// a mirror exists a page is read every SWEEP_EVERY-th run, while a seeding sweep reads a page every run.
export const SWEEP_STAGES = [
  { collection: "initiatives", limit: 150 },
  { collection: "waiting", limit: 100 },
  { collection: "ideas", limit: 100 },
  { collection: "messages", limit: 300 },
  { collection: "ctx", limit: 100 },
  { collection: "plan", limit: 100 },
  { collection: "threads", limit: 400 },
  { collection: "steps", limit: 300, since: true },
];
export const SWEEP_CYCLE_MS = 3 * 24 * 3600e3;
export const SWEEP_EVERY = 4;
export { CURSOR };
// The staging folder and the report the run writes beside its pages.
export const SWEEP_DIR = "sweep";
export const SWEEP_REPORT = "sweep-next.json";
// The mirror's own stamp, inside the mirror folder (a file there is not a collection: readMirror skips it).
export const STAMP_FILE = "_at.json";
export const STEPS_KEEP_DAYS = 7;
const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const DOC = /^[A-Za-z0-9_.@+:~-]{1,200}\.json$/;

// The query field of each delta collection: `at` for the written-once ones, `updatedAt` for the mutable.
export const deltaField = (collection) => (APPENDED.includes(collection) ? "at" : MUTABLE.includes(collection) ? "updatedAt" : null);

// What --prepare tells the run: the mode, the changed-since queries, and at most one sweep page.
// A delta read finds a changed document only by its own updatedAt, so nothing is planned until the gate requires that stamp
// (config.gate.requireUpdatedAt true: the pack's order is enforced here, in code): mode "off", the run reads nothing.
// With a mirror and its state: the delta since the last merged run (less the overlap), plus a sweep page every SWEEP_EVERY-th
// run while a sweep is going. With none: a sweep starts (this run reads its first page, no delta yet), and every later run
// reads a page and the delta since the sweep began, which is laid over the staging folder, so a document changed after its page
// was read is not lost.
export function deltaPlan({ now, state, hasMirror, requireUpdatedAt = false }) {
  if (requireUpdatedAt !== true) return { mode: "off", since: null, queries: [], sweep: null };
  const lastAt = Number.isFinite(state?.at) ? state.at : null;
  const seeded = hasMirror && lastAt !== null;
  const sweptAt = Number.isFinite(state?.fullAt) ? state.fullAt : null;
  let sweep = state?.sweep ?? null, fresh = false;
  if (!sweep && (!seeded || sweptAt === null || now - sweptAt >= SWEEP_CYCLE_MS || sweptAt > now + 60e3)) { sweep = { startedAt: now, stage: 0, cursor: null, runs: 0 }; fresh = true; }
  const ref = seeded ? lastAt : sweep && !fresh ? sweep.startedAt : null;
  const since = ref === null ? null : Math.max(0, ref - OVERLAP_MS);
  const queries = since === null ? [] : [...APPENDED, ...MUTABLE].map((collection) => ({ collection, field: deltaField(collection), since }));
  const page = sweep && (!seeded || fresh || sweep.runs % SWEEP_EVERY === 0);
  const stage = page ? SWEEP_STAGES[sweep.stage] : null;
  return {
    mode: page ? "sweep" : "delta", since, queries,
    sweep: page ? { startedAt: sweep.startedAt, fresh, stage: sweep.stage, collection: stage.collection, limit: stage.limit, cursor: sweep.cursor, ...(stage.since ? { since: Math.max(0, now - STEPS_KEEP_DAYS * 864e5) } : {}) } : null,
  };
}

// The lines the run reads: the query conditions and the sweep page written out in full (the field, the time, the limit and
// the cursor), so the model types no condition of its own.
export function queryLines(plan) {
  if (plan.mode === "off") return ["Mode: off."];
  const out = [plan.since === null ? "Mode: sweep, no delta." : `Mode: ${plan.mode}, since ${plan.since}.`];
  for (const q of plan.queries) out.push(`Query ${q.collection}: where [{"field": "${q.field}", "op": ">=", "value": ${q.since}}]`);
  const s = plan.sweep;
  if (s) out.push(`Sweep ${s.collection}: limit ${s.limit}, cursor ${s.cursor ?? "none"}${s.since === undefined ? "" : `, where [{"field": "at", "op": ">=", "value": ${s.since}}]`}`);
  return out;
}

const regular = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
const directory = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };

// An export is whole when its last step landed: the run reads the version of derived/all last and saves it as
// derived/all.json (the seal). Nothing else is required: a delta or a sweep page that matched nothing saves no file.
export function sealed(exportDir) {
  return regular(join(exportDir, "derived", "all.json"));
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

// The run saves what it read as pages, not one file a document (a call each would be hundreds): <collection>/<name>.page.json
// holding {docs: [{id, data}]}, under the export folder (a delta) or its sweep/ folder (a sweep page). The probe cuts each page
// into the <id>.json files everything else reads, then removes it. A page or a document that does not fit is skipped, never
// repaired; an id ending ".page" is skipped because its file would read as a page. Returns the documents written.
const PAGE_FILE = /^[A-Za-z0-9_.-]{1,100}\.page\.json$/;
export function explodePages(root) {
  let n = 0;
  if (!directory(root)) return n;
  for (const c of readdirSync(root)) {
    const dir = join(root, c);
    if (!NAME.test(c) || !EXPORT_COLLECTIONS.includes(c) || !directory(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!PAGE_FILE.test(f) || !regular(join(dir, f))) continue;
      const page = readDoc(join(dir, f));
      rmSync(join(dir, f), { force: true });
      for (const e of Array.isArray(page?.docs) ? page.docs : []) {
        const ok = e !== null && typeof e === "object" && typeof e.id === "string" && DOC.test(`${e.id}.json`) && !e.id.endsWith(".page")
          && e.data !== null && typeof e.data === "object" && !Array.isArray(e.data);
        if (!ok) continue;
        writeAtomic(join(dir, `${e.id}.json`), JSON.stringify(e.data));
        n++;
      }
    }
  }
  return n;
}

// Lays an export's documents over a folder: each replaces its file, a tombstone removes it. `derived` is never laid: the
// probe makes the mirror's derived/all itself, from what it derives (the export's derived/all.json is only the seal).
export function lay(destDir, exportDir) {
  const out = { merged: 0, removed: 0 };
  if (!directory(exportDir)) return out;
  for (const c of readdirSync(exportDir)) {
    if (!NAME.test(c) || !EXPORT_COLLECTIONS.includes(c) || c === "derived") continue;
    for (const [f, d] of docsOf(exportDir, c)) {
      const dest = join(destDir, c, f);
      if (isTombstone(c, d)) { if (existsSync(dest)) { rmSync(dest, { force: true }); out.removed++; } continue; }
      mkdirSync(join(destDir, c), { recursive: true });
      writeAtomic(dest, JSON.stringify(d, null, 2));
      out.merged++;
    }
  }
  return out;
}

// A full export holds the tombstones of every deletion ever made ({deleted: true, updatedAt}); the drift check reads them, and
// then they go: a tombstone left in the mirror would come back as a card on every read (Checker). Returns how many went.
export function dropTombstones(dir) {
  let n = 0;
  for (const c of MUTABLE) for (const [f, d] of docsOf(dir, c)) if (isTombstone(c, d)) { rmSync(join(dir, c, f), { force: true }); n++; }
  return n;
}

// Lays a delta export over the mirror: each document replaces its file, a tombstone removes it, and the mirror's stamp
// says what the mirror now holds (changes up to `at`, the run's start). Steps older than STEPS_KEEP_DAYS go. Returns counts.
export function mergeDelta(mirrorDir, exportDir, { at, now, keepDays = STEPS_KEEP_DAYS }) {
  const out = { ...lay(mirrorDir, exportDir), pruned: 0 };
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
// sweep (#C655): the sweep going, if any: when it began, the stage and the cursor of the next page, and the runs merged since.
export function readSweep(s) {
  const ok = s !== null && typeof s === "object" && Number.isFinite(s.startedAt) && Number.isInteger(s.stage) && s.stage >= 0 && s.stage < SWEEP_STAGES.length
    && (s.cursor === null || (typeof s.cursor === "string" && CURSOR.test(s.cursor))) && Number.isInteger(s.runs) && s.runs >= 0;
  return ok ? { startedAt: s.startedAt, stage: s.stage, cursor: s.cursor, runs: s.runs } : null;
}
export function readDeltaState(dir) {
  const s = readDoc(join(dir, DELTA_STATE_FILE));
  return s && Number.isFinite(s.at) ? { at: s.at, fullAt: Number.isFinite(s.fullAt) ? s.fullAt : null, lastPrepare: Number.isFinite(s.lastPrepare) ? s.lastPrepare : null, sweep: readSweep(s.sweep) } : null;
}

// Reads what the run saved about its sweep page (<export>/sweep-next.json): {collection, next}, next the board's cursor for
// the page after, or null when the collection is done. Anything else is no report.
export function readSweepReport(exportDir) {
  const r = readDoc(join(exportDir, SWEEP_REPORT));
  if (!r || typeof r.collection !== "string") return null;
  if (r.next !== null && !(typeof r.next === "string" && CURSOR.test(r.next))) return null;
  return { collection: r.collection, next: r.next };
}

// One sweep step, merged (the staging folder is <dir>/sweep and has been prepared by the caller). `mark` is the run's mark
// (its sweep page), `state` the state before it. Returns the sweep that goes on (stage, cursor, runs), or null when the
// last page was just laid and the staging folder is whole.
export function advanceSweep(state, mark, report) {
  const cur = state?.sweep ?? null;
  const page = mark?.sweep ?? null;
  // The sweep this run was planned for must still be the one going (or be the fresh one this run starts).
  let sweep = cur;
  if (page && page.fresh && (!cur || cur.startedAt !== page.startedAt)) sweep = { startedAt: page.startedAt, stage: 0, cursor: null, runs: 0 };
  if (!sweep) return { sweep: null, done: false, matched: false };
  const matched = Boolean(page) && page.startedAt === sweep.startedAt && page.stage === sweep.stage && (page.cursor ?? null) === sweep.cursor
    && Boolean(report) && report.collection === SWEEP_STAGES[sweep.stage].collection;
  if (!matched) return { sweep: { ...sweep, runs: sweep.runs + 1 }, done: false, matched };
  if (report.next !== null) return { sweep: { ...sweep, cursor: report.next, runs: sweep.runs + 1 }, done: false, matched };
  if (sweep.stage + 1 >= SWEEP_STAGES.length) return { sweep: null, done: true, matched, startedAt: sweep.startedAt };
  return { sweep: { ...sweep, stage: sweep.stage + 1, cursor: null, runs: sweep.runs + 1 }, done: false, matched };
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

// The sweep's check: the five mutable collections of the swept board (the staging folder) against the mirror the deltas built.
// Returns the DRIFT lines (none when they agree). A document written after the mirror's stamp is no drift (the sweep is newer than the
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

