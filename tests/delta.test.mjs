import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MUTABLE, APPENDED, OVERLAP_MS, deltaField, fullDue, deltaPlan, queryLines, sealed, mergeDelta, readStamp, writeStamp, driftLines, isTombstone } from "../collector/delta.mjs";

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

test("the plan: a delta since the last run's start less the overlap; a full read with no state, no mirror, or a night a day on", () => {
  const state = { at: NOW - 30 * 60e3, fullAt: NOW - 2 * 3600e3 };
  const p = deltaPlan({ now: NOW, state, hasMirror: true, hour: 14, requireUpdatedAt: true });
  assert.equal(p.mode, "delta");
  assert.equal(p.since, state.at - OVERLAP_MS);
  assert.equal(p.queries.length, 8);
  assert.deepEqual(p.queries.find((q) => q.collection === "steps"), { collection: "steps", field: "at", since: p.since });
  assert.deepEqual(p.queries.find((q) => q.collection === "waiting"), { collection: "waiting", field: "updatedAt", since: p.since });
  assert.equal(deltaPlan({ now: NOW, state: null, hasMirror: true, hour: 14, requireUpdatedAt: true }).mode, "full", "nothing merged yet");
  assert.equal(deltaPlan({ now: NOW, state, hasMirror: false, hour: 14, requireUpdatedAt: true }).mode, "full", "no mirror to add to");
  const old = { at: NOW - 30 * 60e3, fullAt: NOW - 25 * 3600e3 };
  assert.equal(deltaPlan({ now: NOW, state: old, hasMirror: true, hour: 14, requireUpdatedAt: true }).mode, "delta", "a day old but daytime: wait for the night");
  assert.equal(deltaPlan({ now: NOW, state: old, hasMirror: true, hour: 3, requireUpdatedAt: true }).mode, "full", "a day old, at night");
  // The pack order is enforced in code (Checker): until the gate stamps every write, every run is a full read.
  for (const requireUpdatedAt of [false, undefined, "yes", 1]) assert.equal(deltaPlan({ now: NOW, state, hasMirror: true, hour: 14, requireUpdatedAt }).mode, "full", `requireUpdatedAt ${String(requireUpdatedAt)}`);
  assert.equal(deltaPlan({ now: NOW, state, hasMirror: true, hour: 14 }).mode, "full", "not given");
  assert.equal(fullDue({ now: NOW, fullAt: NOW - 31 * 3600e3, hasMirror: true, hour: 14 }), true, "30 hours, whatever the hour");
  assert.equal(fullDue({ now: NOW, fullAt: NOW - 3600e3, hasMirror: true, hour: 3 }), false, "an hour ago: not again");
});

test("the lines the run reads write each condition out, so the model types none of its own", () => {
  const lines = queryLines(deltaPlan({ now: NOW, state: { at: NOW - 1800e3, fullAt: NOW }, hasMirror: true, hour: 10, requireUpdatedAt: true }));
  assert.match(lines[0], /^Mode: delta, since \d+\.$/);
  assert.ok(lines.includes(`Query steps: where [["at", ">=", ${NOW - 1800e3 - OVERLAP_MS}]]`));
  assert.ok(lines.some((l) => /^Query initiatives: where \[\["updatedAt", ">=", \d+\]\]$/.test(l)));
  assert.match(queryLines({ mode: "full" })[0], /^Mode: full/);
});

test("sealed: an export is whole once derived/all.json is there (the run lists derived last); a full one needs its collections too", () => {
  const root = tmp();
  try {
    put(root, "steps", "a", { at: 1 });
    assert.equal(sealed(root, "delta"), false, "the last call has not landed");
    put(root, "derived", "all", { at: 1 });
    assert.equal(sealed(root, "delta"), true);
    assert.equal(sealed(root, "full", ["steps", "initiatives"]), false, "a full read without initiatives");
    put(root, "initiatives", "x", {});
    assert.equal(sealed(root, "full", ["steps", "initiatives"]), true);
    rmSync(join(root, "derived", "all.json"));
    symlinkSync("/etc/hosts", join(root, "derived", "all.json"));
    assert.equal(sealed(root, "delta"), false, "a link is never the seal");
  } finally { rmSync(root, { recursive: true, force: true }); }
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
