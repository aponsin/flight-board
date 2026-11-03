import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MUTABLE, APPENDED, OVERLAP_MS, SWEEP_STAGES, SWEEP_CYCLE_MS, SWEEP_EVERY, STEPS_KEEP_DAYS, deltaField, deltaPlan, queryLines, sealed, mergeDelta, readStamp, writeStamp, driftLines, isTombstone, explodePages, lay, readSweep, readSweepReport, advanceSweep } from "../collector/delta.mjs";
import { READ_COLLECTIONS, EXPORT_COLLECTIONS } from "../collector/export.mjs";

const NOW = Date.UTC(2026, 10, 3, 20, 0, 0) + 12345;
const tmp = () => mkdtempSync(join(tmpdir(), "delta-"));
const put = (root, c, id, doc) => { mkdirSync(join(root, c), { recursive: true }); writeFileSync(join(root, c, `${id}.json`), JSON.stringify(doc)); };
const get = (root, c, id) => JSON.parse(readFileSync(join(root, c, `${id}.json`), "utf8"));
const names = (root, c) => (existsSync(join(root, c)) ? readdirSync(join(root, c)).sort() : []);

test("every exported collection has a delta field or is read whole: appended ones by at, mutable ones by updatedAt", () => {
  for (const c of APPENDED) assert.equal(deltaField(c), "at");
  for (const c of MUTABLE) assert.equal(deltaField(c), "updatedAt");
  assert.equal(deltaField("derived"), null);
  assert.deepEqual([...APPENDED, ...MUTABLE].sort(), ["ctx", "ideas", "initiatives", "messages", "plan", "steps", "threads", "waiting"]);
});

const fresh = { at: NOW - 30 * 60e3, fullAt: NOW - 2 * 3600e3, sweep: null };

test("the plan: a delta since the last run's start less the overlap, with no page unless a sweep is going", () => {
  const p = deltaPlan({ now: NOW, state: fresh, hasMirror: true, requireUpdatedAt: true });
  assert.equal(p.mode, "delta");
  assert.equal(p.since, fresh.at - OVERLAP_MS);
  assert.equal(p.sweep, null, "the last sweep is two hours old");
  assert.equal(p.queries.length, 8);
  assert.deepEqual(p.queries.find((q) => q.collection === "steps"), { collection: "steps", field: "at", since: p.since });
  assert.deepEqual(p.queries.find((q) => q.collection === "waiting"), { collection: "waiting", field: "updatedAt", since: p.since });
});

test("the plan: with no mirror, or no state, the first sweep page and no delta; the pack order is enforced in code (mode off)", () => {
  for (const [state, hasMirror] of [[null, true], [fresh, false], [null, false]]) {
    const p = deltaPlan({ now: NOW, state, hasMirror, requireUpdatedAt: true });
    assert.equal(p.mode, "sweep");
    assert.equal(p.since, null, "nothing to add a delta to yet");
    assert.deepEqual(p.queries, []);
    assert.deepEqual(p.sweep, { startedAt: NOW, fresh: true, stage: 0, collection: "initiatives", limit: 150, cursor: null });
  }
  for (const requireUpdatedAt of [false, undefined, "yes", 1]) {
    const p = deltaPlan({ now: NOW, state: fresh, hasMirror: true, requireUpdatedAt });
    assert.equal(p.mode, "off", `requireUpdatedAt ${String(requireUpdatedAt)}`);
    assert.deepEqual([p.queries, p.sweep], [[], null]);
  }
  assert.equal(deltaPlan({ now: NOW, state: fresh, hasMirror: true }).mode, "off", "not given");
});

test("the plan: a sweep starts when the last is three days old; a going sweep reads a page every SWEEP_EVERY-th run, or every run while seeding", () => {
  const old = { ...fresh, fullAt: NOW - SWEEP_CYCLE_MS };
  const start = deltaPlan({ now: NOW, state: old, hasMirror: true, requireUpdatedAt: true });
  assert.equal(start.mode, "sweep");
  assert.equal(start.sweep.fresh, true);
  assert.equal(start.since, old.at - OVERLAP_MS, "a mirror exists: its delta goes on");
  assert.equal(deltaPlan({ now: NOW, state: { ...fresh, fullAt: NOW - SWEEP_CYCLE_MS + 60e3 }, hasMirror: true, requireUpdatedAt: true }).mode, "delta", "not yet");
  assert.equal(deltaPlan({ now: NOW, state: { ...fresh, fullAt: NOW + 3600e3 }, hasMirror: true, requireUpdatedAt: true }).sweep.fresh, true, "a stamp from the future is no sweep");
  // Going, with a mirror: every SWEEP_EVERY-th run.
  const going = (runs, stage = 3, cursor = "c1") => ({ ...fresh, sweep: { startedAt: NOW - 3600e3, stage, cursor, runs } });
  for (let runs = 0; runs < 2 * SWEEP_EVERY; runs++) {
    const p = deltaPlan({ now: NOW, state: going(runs), hasMirror: true, requireUpdatedAt: true });
    assert.equal(p.mode, runs % SWEEP_EVERY === 0 ? "sweep" : "delta", `run ${runs}`);
    assert.equal(p.since, fresh.at - OVERLAP_MS);
  }
  assert.deepEqual(deltaPlan({ now: NOW, state: going(0), hasMirror: true, requireUpdatedAt: true }).sweep, { startedAt: NOW - 3600e3, fresh: false, stage: 3, collection: "messages", limit: 300, cursor: "c1" });
  // Seeding (no mirror): a page every run, and the delta since the sweep began.
  const seeding = deltaPlan({ now: NOW, state: { at: NOW - 600e3, fullAt: null, sweep: { startedAt: NOW - 3600e3, stage: 1, cursor: null, runs: 3 } }, hasMirror: false, requireUpdatedAt: true });
  assert.equal(seeding.mode, "sweep");
  assert.equal(seeding.since, NOW - 3600e3 - OVERLAP_MS);
  assert.equal(seeding.queries.length, 8);
  assert.equal(seeding.sweep.collection, "waiting");
});

test("the steps stage reads by at, from seven days back; the stages are exported collections, and a page is a size a run can copy", () => {
  const last = SWEEP_STAGES.length - 1;
  const p = deltaPlan({ now: NOW, state: { at: NOW, fullAt: NOW, sweep: { startedAt: NOW, stage: last, cursor: null, runs: 0 } }, hasMirror: true, requireUpdatedAt: true });
  assert.equal(p.sweep.collection, "steps");
  assert.equal(p.sweep.since, NOW - STEPS_KEEP_DAYS * 864e5);
  assert.deepEqual(SWEEP_STAGES.map((s) => s.collection).sort(), [...READ_COLLECTIONS].sort(), "every collection the run reads is swept once");
  assert.ok(!SWEEP_STAGES.some((s) => s.collection === "derived") && EXPORT_COLLECTIONS.includes("derived"));
  assert.ok(SWEEP_STAGES.every((s) => s.limit >= 1 && s.limit <= 1000));
});

test("the lines the run reads write each condition and the sweep page out, so the model types none of its own", () => {
  const lines = queryLines(deltaPlan({ now: NOW, state: { at: NOW - 1800e3, fullAt: NOW, sweep: { startedAt: NOW - 3600e3, stage: 7, cursor: "cur_1=", runs: 0 } }, hasMirror: true, requireUpdatedAt: true }));
  assert.match(lines[0], /^Mode: sweep, since \d+\.$/);
  assert.ok(lines.includes(`Query steps: where [{"field": "at", "op": ">=", "value": ${NOW - 1800e3 - OVERLAP_MS}}]`));
  assert.ok(lines.some((l) => /^Query initiatives: where \[\{"field": "updatedAt", "op": ">=", "value": \d+\}\]$/.test(l)));
  assert.ok(lines.includes(`Sweep steps: limit 300, cursor cur_1=, where [{"field": "at", "op": ">=", "value": ${NOW - STEPS_KEEP_DAYS * 864e5}}]`));
  assert.deepEqual(queryLines({ mode: "off" }), ["Mode: off."]);
  assert.deepEqual(queryLines(deltaPlan({ now: NOW, state: null, hasMirror: false, requireUpdatedAt: true })), ["Mode: sweep, no delta.", "Sweep initiatives: limit 150, cursor none"]);
});

test("sealed: an export is whole once derived/all.json is there (the run saves it last); a link is never the seal", () => {
  const root = tmp();
  try {
    put(root, "steps", "a", { at: 1 });
    assert.equal(sealed(root), false, "the last step has not landed");
    put(root, "derived", "all", { version: 3 });
    assert.equal(sealed(root), true);
    rmSync(join(root, "derived", "all.json"));
    symlinkSync("/etc/hosts", join(root, "derived", "all.json"));
    assert.equal(sealed(root), false, "a link is never the seal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const page = (root, c, name, docs) => { mkdirSync(join(root, c), { recursive: true }); writeFileSync(join(root, c, `${name}.page.json`), JSON.stringify({ docs })); };

test("explodePages cuts a page into <id>.json files and removes it; a document or a page that does not fit is skipped, never repaired", () => {
  const root = tmp();
  try {
    page(root, "initiatives", "q1", [{ id: "a", data: { name: "A" } }, { id: "b.c", data: { name: "B" } }, { id: "s1793-x", data: { deleted: true, updatedAt: 2 } }]);
    page(root, "waiting", "q1", [{ id: "../up", data: {} }, { id: "x.page", data: {} }, { id: "ok", data: [1] }, { id: "n", data: null }, { id: "fine", data: { text: "t" } }, "junk", { id: 5, data: {} }]);
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "q1.page.json"), JSON.stringify({ docs: [{ id: "z", data: {} }] }));
    writeFileSync(join(root, "messages-bad.page.json"), "{");
    mkdirSync(join(root, "messages"));
    writeFileSync(join(root, "messages", "q1.page.json"), "{not json");
    writeFileSync(join(root, "messages", "q2.page.json"), JSON.stringify({ nodocs: true }));
    assert.equal(explodePages(root), 4);
    assert.deepEqual(names(root, "initiatives"), ["a.json", "b.c.json", "s1793-x.json"]);
    assert.deepEqual(get(root, "initiatives", "a"), { name: "A" });
    assert.deepEqual(names(root, "waiting"), ["fine.json"]);
    assert.deepEqual(names(root, "messages"), [], "a page that is not a page is removed and leaves nothing");
    assert.deepEqual(names(root, "elsewhere"), ["q1.page.json"], "only the exported collections are cut");
    assert.equal(explodePages(join(root, "nowhere")), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lay: documents replace their files, a tombstone removes one, derived is never laid, and a delta laid after a page wins", () => {
  const dest = tmp(), pg = tmp(), dl = tmp();
  try {
    put(dest, "initiatives", "gone", { name: "g" });
    put(pg, "initiatives", "x", { name: "page", updatedAt: 1 });
    put(pg, "derived", "all", { version: 1 });
    put(dl, "initiatives", "x", { name: "delta", updatedAt: 2 });
    put(dl, "initiatives", "gone", { deleted: true, updatedAt: 3 });
    assert.deepEqual(lay(dest, pg), { merged: 1, removed: 0 });
    assert.deepEqual(lay(dest, dl), { merged: 1, removed: 1 });
    assert.equal(get(dest, "initiatives", "x").name, "delta");
    assert.deepEqual(names(dest, "initiatives"), ["x.json"]);
    assert.equal(existsSync(join(dest, "derived")), false, "the seal is not a board document");
    assert.deepEqual(lay(dest, join(dest, "nowhere")), { merged: 0, removed: 0 });
  } finally { for (const d of [dest, pg, dl]) rmSync(d, { recursive: true, force: true }); }
});

test("readSweepReport and readSweep take only what fits: the collection, the board's cursor characters, a stage in range", () => {
  const root = tmp();
  try {
    const w = (o) => writeFileSync(join(root, "sweep-next.json"), typeof o === "string" ? o : JSON.stringify(o));
    w({ collection: "waiting", next: "abc_1=" }); assert.deepEqual(readSweepReport(root), { collection: "waiting", next: "abc_1=" });
    w({ collection: "waiting", next: null }); assert.deepEqual(readSweepReport(root), { collection: "waiting", next: null });
    for (const bad of [{ collection: "waiting", next: "a b" }, { collection: "waiting", next: "x\ny" }, { collection: "waiting", next: 5 }, { collection: "waiting" }, { next: null }, "{", "[]"]) { w(bad); assert.equal(readSweepReport(root), null, JSON.stringify(bad)); }
  } finally { rmSync(root, { recursive: true, force: true }); }
  const ok = { startedAt: 5, stage: 2, cursor: null, runs: 0 };
  assert.deepEqual(readSweep(ok), ok);
  for (const bad of [null, {}, { ...ok, stage: SWEEP_STAGES.length }, { ...ok, stage: -1 }, { ...ok, cursor: "a b" }, { ...ok, cursor: 3 }, { ...ok, runs: -1 }, { ...ok, startedAt: "x" }]) assert.equal(readSweep(bad), null, JSON.stringify(bad));
});

test("advanceSweep: a page moves the sweep on by its cursor, then its collection; the last page ends it; a page that is not the planned one is not laid", () => {
  const st = (stage, cursor = null, runs = 0) => ({ sweep: { startedAt: 100, stage, cursor, runs } });
  const mark = (stage, cursor = null, fresh = false) => ({ sweep: { startedAt: 100, fresh, stage, collection: SWEEP_STAGES[stage].collection, limit: 1, cursor } });
  const name = (s) => SWEEP_STAGES[s].collection;
  assert.deepEqual(advanceSweep(st(0), mark(0), { collection: name(0), next: "k1" }), { sweep: { startedAt: 100, stage: 0, cursor: "k1", runs: 1 }, done: false, matched: true });
  assert.deepEqual(advanceSweep(st(0, "k1"), mark(0, "k1"), { collection: name(0), next: null }).sweep, { startedAt: 100, stage: 1, cursor: null, runs: 1 });
  const last = SWEEP_STAGES.length - 1;
  assert.deepEqual(advanceSweep(st(last), mark(last), { collection: name(last), next: null }), { sweep: null, done: true, matched: true, startedAt: 100 });
  // A fresh sweep begins from its first stage whatever the state held.
  assert.deepEqual(advanceSweep(null, mark(0, null, true), { collection: name(0), next: "k" }).sweep, { startedAt: 100, stage: 0, cursor: "k", runs: 1 });
  assert.equal(advanceSweep({ sweep: { startedAt: 7, stage: 4, cursor: "z", runs: 9 } }, mark(0, null, true), { collection: name(0), next: null }).sweep.startedAt, 100, "a fresh plan replaces an older sweep");
  // Not matched: no report, the wrong collection, a page of another sweep, another cursor. The runs still count.
  for (const [s, m, r] of [[st(0), mark(0), null], [st(0), mark(0), { collection: name(1), next: null }], [st(0), { sweep: { ...mark(0).sweep, startedAt: 99 } }, { collection: name(0), next: null }], [st(0, "k1"), mark(0, "k2"), { collection: name(0), next: null }], [st(2), mark(1), { collection: name(1), next: null }]]) {
    const out = advanceSweep(s, m, r);
    assert.equal(out.matched, false);
    assert.deepEqual(out.sweep, { ...s.sweep, runs: 1 });
  }
  // A delta-only run (no page in the mark) while a sweep goes: the sweep stays, its run count rises.
  assert.deepEqual(advanceSweep(st(3, "c", 2), { sweep: null }, null), { sweep: { startedAt: 100, stage: 3, cursor: "c", runs: 3 }, done: false, matched: false });
  assert.deepEqual(advanceSweep({ sweep: null }, { sweep: null }, null), { sweep: null, done: false, matched: false });
});

test("mergeDelta: a changed document replaces its file, a new one is added, a tombstone removes it, the rest is left; the stamp says what the mirror holds", () => {
  const mirror = tmp(), exp = tmp();
  try {
    put(mirror, "initiatives", "keep", { name: "keep", updatedAt: 1 });
    put(mirror, "initiatives", "edit", { name: "old", updatedAt: 1 });
    put(mirror, "waiting", "drop", { text: "x", updatedAt: 1 });
    put(exp, "initiatives", "edit", { name: "new", updatedAt: NOW - 1000 });
    put(exp, "initiatives", "fresh", { name: "fresh", updatedAt: NOW - 500 });
    put(exp, "waiting", "drop", { deleted: true, updatedAt: NOW - 100 });
    put(exp, "messages", "m1", { at: NOW - 50, text: "hi" });
    const out = mergeDelta(mirror, exp, { at: NOW - 60e3, now: NOW });
    assert.deepEqual(out, { merged: 3, removed: 1, pruned: 0 });
    assert.deepEqual(names(mirror, "initiatives").filter((f) => f.endsWith(".json")), ["edit.json", "fresh.json", "keep.json"]);
    assert.equal(get(mirror, "initiatives", "edit").name, "new");
    assert.equal(get(mirror, "initiatives", "keep").name, "keep");
    assert.equal(existsSync(join(mirror, "waiting", "drop.json")), false, "the tombstone removed it");
    assert.equal(get(mirror, "messages", "m1").text, "hi", "a collection the mirror did not have yet");
    assert.deepEqual(readStamp(mirror), { at: NOW - 60e3, mergedAt: NOW });
    // Idempotent: the overlap reads a document twice.
    assert.deepEqual(mergeDelta(mirror, exp, { at: NOW - 60e3, now: NOW }), { merged: 3, removed: 0, pruned: 0 });
  } finally { rmSync(mirror, { recursive: true, force: true }); rmSync(exp, { recursive: true, force: true }); }
});

test("mergeDelta keeps out what is not a document: links, odd names, unknown collections, a tombstone in an appended collection is just a document", () => {
  const mirror = tmp(), exp = tmp();
  try {
    put(exp, "initiatives", "ok", { name: "ok" });
    symlinkSync("/etc/hosts", join(exp, "initiatives", "evil.json"));
    writeFileSync(join(exp, "initiatives", "notes.txt"), "x");
    writeFileSync(join(exp, "initiatives", "bad.json"), "{not json");
    put(exp, "elsewhere", "y", { name: "y" });
    put(exp, "steps", "s", { at: NOW, deleted: true });
    const out = mergeDelta(mirror, exp, { at: NOW, now: NOW });
    assert.deepEqual(names(mirror, "initiatives"), ["ok.json"]);
    assert.equal(existsSync(join(mirror, "elsewhere")), false, "only the exported collections");
    assert.equal(out.merged, 2);
    assert.equal(get(mirror, "steps", "s").deleted, true, "steps are never tombstoned: kept as written");
    assert.equal(isTombstone("steps", { deleted: true }), false);
    assert.equal(isTombstone("waiting", { deleted: true }), true);
  } finally { rmSync(mirror, { recursive: true, force: true }); rmSync(exp, { recursive: true, force: true }); }
});

test("mergeDelta drops steps older than seven days from the mirror and keeps newer ones", () => {
  const mirror = tmp(), exp = tmp();
  try {
    put(mirror, "steps", "old", { at: NOW - 8 * 864e5 });
    put(mirror, "steps", "recent", { at: NOW - 6 * 864e5 });
    put(mirror, "steps", "noat", { init: "x" });
    const out = mergeDelta(mirror, exp, { at: NOW, now: NOW });
    assert.equal(out.pruned, 1);
    assert.deepEqual(names(mirror, "steps"), ["noat.json", "recent.json"]);
  } finally { rmSync(mirror, { recursive: true, force: true }); rmSync(exp, { recursive: true, force: true }); }
});

test("driftLines: a full read that differs from the merged mirror is named per collection; newer stamped writes and an agreeing board are not drift", () => {
  const mirror = tmp(), full = tmp();
  try {
    writeStamp(mirror, NOW - 600e3, NOW - 590e3);
    put(mirror, "initiatives", "same", { name: "a", updatedAt: 5 });
    put(mirror, "initiatives", "edited", { name: "old" });
    put(mirror, "initiatives", "gone", { name: "g" });
    put(mirror, "initiatives", "newer", { name: "n0", updatedAt: 6 });
    put(mirror, "waiting", "w1", { text: "t", updatedAt: 7 });
    put(full, "initiatives", "same", { name: "a", updatedAt: 5 });
    put(full, "initiatives", "edited", { name: "new" });
    put(full, "initiatives", "created", { name: "c" });
    put(full, "initiatives", "newer", { name: "n1", updatedAt: NOW - 100e3 });
    put(full, "initiatives", "late", { name: "l", updatedAt: NOW - 100e3 });
    put(full, "waiting", "w1", { text: "t", updatedAt: 7 });
    const lines = driftLines(mirror, full);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^MIRROR DRIFT initiatives: changed with no newer updatedAt 1 \(edited\); created and never seen 1 \(created\); deleted on the board, still in the mirror 1 \(gone\)\./);
    assert.doesNotMatch(lines[0], /newer\b.*\(newer\)|late/, "a write after the stamp is the next delta's");
    for (const f of ["edited", "created"]) put(mirror, "initiatives", f, { name: f });
    rmSync(join(mirror, "initiatives", "gone.json"));
    put(full, "initiatives", "edited", { name: "edited" });
    put(full, "initiatives", "created", { name: "created" });
    put(mirror, "initiatives", "late", { name: "l", updatedAt: NOW - 100e3 });
    put(mirror, "initiatives", "newer", { name: "n1", updatedAt: NOW - 100e3 });
    assert.deepEqual(driftLines(mirror, full), [], "they agree");
  } finally { rmSync(mirror, { recursive: true, force: true }); rmSync(full, { recursive: true, force: true }); }
});

test("driftLines: a tombstone on the board with the document still in the mirror is drift; a tombstone the mirror never had is not", () => {
  const mirror = tmp(), full = tmp();
  try {
    writeStamp(mirror, NOW - 600e3, NOW);
    put(mirror, "waiting", "x", { text: "x", updatedAt: 1 });
    put(full, "waiting", "x", { deleted: true, updatedAt: 2 });
    put(full, "waiting", "never", { deleted: true, updatedAt: 2 });
    const lines = driftLines(mirror, full);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /MIRROR DRIFT waiting: deleted on the board, still in the mirror 1 \(x\)/);
  } finally { rmSync(mirror, { recursive: true, force: true }); rmSync(full, { recursive: true, force: true }); }
});
