import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeRun, scratchRoot, EXPORT_NAME } from "../collector/collect.mjs";
import { MUTABLE, OVERLAP_MS, readStamp, readDeltaState, writeDeltaState, writeStamp, deriveDue, deriveLines, saveLines, DERIVE_EVERY_MS, DERIVE_FILE } from "../collector/delta.mjs";
import { readMirror, TOMBSTONED } from "../gate/gate.mjs";
import { writeErrors, checkWrites, updatedAtErrors, STAMPED, STAMP_WINDOW_MS } from "../gate/rules.mjs";
import { linesOf, linesPending, linesSeen, LINES_MAX, LINE_MAX } from "../gate/reset.mjs";
import { tick } from "../scripts/wake-watch.mjs";
import { fullConfig, checkConfig } from "../scripts/config.mjs";

const NOW = 1_793_735_000_000 + 4321;
const uid = process.getuid();
const put = (root, c, id, doc) => { mkdirSync(join(root, c), { recursive: true }); writeFileSync(join(root, c, `${id}.json`), JSON.stringify(doc)); };
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

// A board folder, its scratch root (the Collector runs in the board folder, so its scratchpads sit under it) and a run's export.
function board() {
  const base = mkdtempSync(join(tmpdir(), "c642-"));
  const dir = join(base, "state", "Board01");
  mkdirSync(dir, { recursive: true });
  const root = scratchRoot(dir, uid, join(base, "tmp"));
  const run = (name, { mode, at, docs = {}, seal = true }) => {
    writeFileSync(join(dir, "export-since.json"), JSON.stringify({ at, refs: {}, mode }));
    const exp = join(root, name, "scratchpad", EXPORT_NAME);
    for (const [c, list] of Object.entries(docs)) for (const [id, d] of Object.entries(list)) put(exp, c, id, d);
    if (seal) put(exp, "derived", "all", { at });
    return exp;
  };
  return { base, dir, root, run, merge: (now = NOW) => mergeRun({ dir, id: "Board01", uid, now, base: join(base, "tmp") }), done: () => rmSync(base, { recursive: true, force: true }) };
}

test("mergeRun: a full read makes the mirror and the state; a delta after it is laid over; the same run is never merged twice", async () => {
  const b = board();
  try {
    const t0 = NOW - 3600e3;
    b.run("s1", { mode: "full", at: t0, docs: { initiatives: { a: { name: "a" }, b: { name: "b" } }, waiting: { w: { text: "w" } }, steps: { s: { at: t0 - 5 } } } });
    for (const c of ["ideas", "messages", "ctx"]) put(join(b.root, "s1", "scratchpad", EXPORT_NAME), c, "x", { at: t0 });
    const full = b.merge();
    assert.equal(full.did, "full");
    assert.deepEqual(full.lines, [], "the first read has nothing to compare with");
    assert.equal(read(join(b.dir, "mirror", "initiatives", "a.json")).name, "a");
    assert.deepEqual(readStamp(join(b.dir, "mirror")), { at: t0, mergedAt: NOW });
    assert.deepEqual(readDeltaState(b.dir), { at: t0, fullAt: t0, lastPrepare: t0 });
    assert.equal(b.merge().did, null, "the same run: nothing to merge again");
    // Even if its export is still there (a folder that could not be removed), a run already merged is not merged again.
    b.run("s1", { mode: "full", at: t0, docs: { initiatives: { a: { name: "again" } } } });
    for (const c of ["waiting", "ideas", "messages", "ctx", "steps"]) put(join(b.root, "s1", "scratchpad", EXPORT_NAME), c, "x", { at: t0 });
    assert.equal(b.merge().did, null, "the same run's export, left behind");
    assert.equal(read(join(b.dir, "mirror", "initiatives", "a.json")).name, "a");
    // The next run, a delta that edits a, removes w, adds c.
    await new Promise((r) => setTimeout(r, 15));
    const t1 = NOW - 1800e3;
    const exp = b.run("s2", { mode: "delta", at: t1, docs: { initiatives: { a: { name: "a2", updatedAt: t1 }, c: { name: "c", updatedAt: t1 } }, waiting: { w: { deleted: true, updatedAt: t1 } } } });
    const delta = b.merge(NOW + 1000);
    assert.equal(delta.did, "delta");
    assert.deepEqual([delta.merged, delta.removed], [3, 1], "a, c and the sealing derived/all written, and the tombstone removed w");
    assert.equal(read(join(b.dir, "mirror", "initiatives", "a.json")).name, "a2");
    assert.equal(read(join(b.dir, "mirror", "initiatives", "b.json")).name, "b", "untouched");
    assert.equal(existsSync(join(b.dir, "mirror", "waiting", "w.json")), false);
    assert.equal(existsSync(exp), false, "the merged export is removed, so nothing takes it twice");
    assert.deepEqual(readDeltaState(b.dir), { at: t1, fullAt: t0, lastPrepare: t1 }, "the next delta starts from this run");
    assert.equal(readStamp(join(b.dir, "mirror")).at, t1);
  } finally { b.done(); }
});

test("mergeRun: an export without its seal is not merged (the run is still listing); a run older than the mark never counts", () => {
  const b = board();
  try {
    writeDeltaState(b.dir, { at: NOW - 7200e3, fullAt: NOW - 7200e3, lastPrepare: NOW - 7200e3 });
    mkdirSync(join(b.dir, "mirror", "initiatives"), { recursive: true });
    b.run("half", { mode: "delta", at: NOW - 1800e3, docs: { steps: { s: { at: NOW - 1700e3 } } }, seal: false });
    assert.equal(b.merge().did, null, "derived/all.json is listed last: not there yet");
    put(join(b.root, "half", "scratchpad", EXPORT_NAME), "derived", "all", { at: 1 });
    assert.equal(b.merge().did, "delta");
    // A mark with no mode (the older run) is left to collect.mjs's own step.
    writeFileSync(join(b.dir, "export-since.json"), JSON.stringify({ at: NOW - 600e3, refs: {} }));
    assert.equal(b.merge().did, null);
  } finally { b.done(); }
});

test("mergeRun: a nightly read that differs from the merged mirror prints MIRROR DRIFT and then replaces the mirror", async () => {
  const b = board();
  try {
    const t0 = NOW - 7200e3;
    mkdirSync(join(b.dir, "mirror", "initiatives"), { recursive: true });
    put(join(b.dir, "mirror"), "initiatives", "ok", { name: "ok", updatedAt: 1 });
    put(join(b.dir, "mirror"), "initiatives", "stale", { name: "stale" });
    put(join(b.dir, "mirror"), "initiatives", "hard-deleted", { name: "gone" });
    put(join(b.dir, "mirror"), "waiting", "w", { text: "w" });
    put(join(b.dir, "mirror"), "ideas", "x", { at: NOW });
    writeStamp(join(b.dir, "mirror"), t0, t0);
    writeDeltaState(b.dir, { at: t0, fullAt: t0 - 86400e3, lastPrepare: t0 });
    const exp = b.run("night", { mode: "full", at: NOW - 600e3, docs: { initiatives: { ok: { name: "ok", updatedAt: 1 }, stale: { name: "edited by a writer with no stamp" } }, waiting: { w: { text: "w" } } } });
    for (const c of ["ideas", "messages", "ctx", "steps"]) put(exp, c, "x", { at: NOW });
    const out = b.merge();
    assert.equal(out.did, "full");
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], /^MIRROR DRIFT initiatives: changed with no newer updatedAt 1 \(stale\); deleted on the board, still in the mirror 1 \(hard-deleted\)/);
    assert.equal(read(join(b.dir, "mirror", "initiatives", "stale.json")).name, "edited by a writer with no stamp", "the full read is the mirror now");
    assert.equal(existsSync(join(b.dir, "mirror", "initiatives", "hard-deleted.json")), false);
    assert.equal(readDeltaState(b.dir).fullAt, NOW - 600e3);
    assert.ok(readStamp(join(b.dir, "mirror")).at === NOW - 600e3);
  } finally { b.done(); }
});

test("a full read holding a tombstone: mergeRun leaves it out of the mirror, and readMirror shows no card for it (Checker)", () => {
  const b = board();
  try {
    const t0 = NOW - 600e3;
    const exp = b.run("night", { mode: "full", at: t0, docs: { initiatives: { live: { name: "live", updatedAt: 1 }, dead: { deleted: true, updatedAt: 2 } }, waiting: { gone: { deleted: true, updatedAt: 3 } }, plan: { p: { deleted: true, updatedAt: 4 } } } });
    for (const c of ["ideas", "messages", "ctx", "steps"]) put(exp, c, "x", { at: NOW });
    const out = b.merge();
    assert.equal(out.did, "full");
    for (const [c, id] of [["initiatives", "dead"], ["waiting", "gone"], ["plan", "p"]]) assert.equal(existsSync(join(b.dir, "mirror", c, `${id}.json`)), false, `${c}/${id} tombstone is not kept`);
    assert.equal(existsSync(join(b.dir, "mirror", "initiatives", "live.json")), true);
    const m = readMirror(join(b.dir, "mirror"));
    assert.deepEqual(m.docs.initiatives.map((d) => d.id), ["live"]);
    // A tombstone left in a mirror by some other way is no card either.
    put(join(b.dir, "mirror"), "waiting", "left", { deleted: true, updatedAt: 5 });
    assert.deepEqual(readMirror(join(b.dir, "mirror")).docs.waiting.map((d) => d.id), []);
    // Outside the five edited collections the word means nothing: steps keep every document.
    put(join(b.dir, "mirror"), "steps", "odd", { deleted: true, at: 1 });
    assert.deepEqual(readMirror(join(b.dir, "mirror")).docs.steps.map((d) => d.id).sort(), ["odd", "x"].sort());
  } finally { b.done(); }
});

test("the constants are tied: the gate's tombstoned collections are the collector's mutable ones; the stamp window is inside the overlap", () => {
  assert.deepEqual([...TOMBSTONED].sort(), [...MUTABLE].sort(), "gate/gate.mjs does not import the collector, so this test ties the two lists");
  assert.ok(STAMP_WINDOW_MS <= OVERLAP_MS, "a write stamped up to the window ago must still fall inside the next delta's overlap");
  assert.ok(STAMP_WINDOW_MS > 0);
  assert.match(updatedAtErrors(w("update", "waiting", "x", { updatedAt: NOW - STAMP_WINDOW_MS - 1000 }), NOW)[0] ?? "", new RegExp(`more than ${STAMP_WINDOW_MS / 60e3} minutes old`), "the message derives its minutes from the constant");
});

test("mergeRun: a delta marked while no mirror exists takes nothing and writes no state (it would otherwise pass as a whole read)", () => {
  const b = board();
  try {
    const t1 = NOW - 600e3;
    const exp = b.run("lonely", { mode: "delta", at: t1, docs: { initiatives: { a: { name: "a", updatedAt: t1 } } } });
    assert.equal(b.merge().did, null);
    assert.equal(existsSync(join(b.dir, "mirror")), false, "no mirror made from a delta");
    assert.equal(readDeltaState(b.dir), null, "no state, so the next run plans a full read");
    assert.equal(existsSync(exp), true, "the export is left where it was");
  } finally { b.done(); }
});

test("a nightly read with a collection of exactly whole pages is reported as cut, as it always was", () => {
  const b = board();
  try {
    const exp = b.run("full", { mode: "full", at: NOW - 600e3, docs: { initiatives: { a: { name: "a" } }, waiting: { w: { text: "w" } } } });
    for (const c of ["ideas", "ctx", "steps"]) put(exp, c, "x", { at: NOW });
    for (let i = 0; i < 1000; i++) put(exp, "messages", `m${i}`, { at: NOW, text: "x" });
    const out = b.merge();
    assert.equal(out.did, "full");
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], /^NUDGE the board export may be cut: messages \(1000\) came back with exactly a full page/);
  } finally { b.done(); }
});

test("readMirror: a delta-built mirror is as current as its stamp says, however old its newest file; a mirror without a stamp is as before", () => {
  const b = board();
  try {
    const mirror = join(b.dir, "mirror");
    put(mirror, "initiatives", "a", { name: "a" });
    const old = new Date(NOW - 5 * 3600e3);
    utimesSync(join(mirror, "initiatives", "a.json"), old, old);
    const before = readMirror(mirror);
    assert.ok(Math.abs(before.at - old.getTime()) < 2000, "no stamp: the files' time");
    writeStamp(mirror, NOW - 60e3, NOW - 55e3);
    const after = readMirror(mirror);
    assert.equal(after.at, NOW - 60e3);
    assert.equal(after.atBy.initiatives, NOW - 60e3, "the collection was listed in the delta too");
    assert.ok(Math.abs(after.atDoc.initiatives.a - old.getTime()) < 2000, "each document keeps its own file time");
    assert.deepEqual(after.docs.initiatives.map((d) => d.id), ["a"], "the stamp file is no collection");
  } finally { b.done(); }
});

test("deriveDue: after a merge, with no output yet, or ten minutes after the last derive; not otherwise", () => {
  const t = { now: NOW, last: NOW - 60e3, outExists: true };
  assert.equal(deriveDue({ ...t, merged: null }), false);
  assert.equal(deriveDue({ ...t, merged: "delta" }), true);
  assert.equal(deriveDue({ ...t, merged: null, outExists: false }), true);
  assert.equal(deriveDue({ ...t, merged: null, last: NOW - DERIVE_EVERY_MS }), true);
  assert.equal(deriveDue({ ...t, merged: null, last: null }), true);
  assert.equal(deriveDue({ ...t, merged: null, last: NOW + 3600e3 }), true, "a clock that ran ahead does not hold it off");
  assert.equal(DERIVE_FILE, "derive-run.json");
});

test("deriveLines keeps the lines the Collector used to send the lead, and saveLines writes them for the lead's watch", () => {
  const out = ["Derived 3 open card(s) into /x.", "CONFLICT a: ...", "LIVE BUT OPEN (1): b", "NUDGE c waits", "KEEPER x", "MIRROR DRIFT waiting: ...", "MEMORY set ctx/Manager from /f", "PICKUP r: 2 digest(s) refreshed"].join("\n");
  assert.deepEqual(deriveLines(out), ["CONFLICT a: ...", "LIVE BUT OPEN (1): b", "NUDGE c waits", "KEEPER x", "MIRROR DRIFT waiting: ..."]);
  const base = mkdtempSync(join(tmpdir(), "c642-l-"));
  try {
    assert.equal(saveLines(base, [], NOW), false, "nothing to say: no file, so the seen batch stands");
    assert.equal(existsSync(join(base, "collector-lines.json")), false);
    assert.equal(saveLines(base, ["NUDGE x"], NOW), true);
    assert.deepEqual(read(join(base, "collector-lines.json")), { at: NOW, lines: ["NUDGE x"] });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the lead's watch prints a batch of lines once, and only the kinds the Collector sent; a planted file is cut to a few short lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "c642-w-"));
  try {
    writeFileSync(join(dir, "collector-lines.json"), JSON.stringify({ at: NOW, lines: ["NUDGE one", "MIRROR DRIFT waiting: x", "rm -rf /", "MEMORY set ctx/Manager"] }));
    assert.equal(tick(dir, NOW + 1000), "NUDGE one\nMIRROR DRIFT waiting: x");
    assert.equal(tick(dir, NOW + 2000), null, "the same batch is not printed again");
    writeFileSync(join(dir, "collector-lines.json"), JSON.stringify({ at: NOW + 5, lines: ["NUDGE two"] }));
    assert.equal(tick(dir, NOW + 3000), "NUDGE two", "a new batch is");
    const many = Array.from({ length: LINES_MAX + 10 }, (_, i) => `NUDGE ${i} ${"x".repeat(LINE_MAX * 2)}`);
    const shown = linesOf({ at: 1, lines: many });
    assert.equal(shown.length, LINES_MAX);
    assert.ok(shown.every((l) => l.length <= LINE_MAX));
    assert.deepEqual(linesPending({ at: 7, lines: ["NUDGE a"] }, linesSeen({ at: 7 })), []);
    assert.deepEqual(linesOf({ at: "x", lines: ["NUDGE a"] }), []);
    assert.deepEqual(linesOf(null), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The gate: with gate.requireUpdatedAt every write to a collection edited in place says when it was made; a delete is a tombstone.
const cfg = (on) => fullConfig({ owner: "Sam", gate: { requireUpdatedAt: on } });
const who = { role: "Builder", manager: false };
const w = (op, collection, doc_id, data) => ({ op, collection, doc_id, data });

test("gate.requireUpdatedAt is a config switch, off by default, a boolean when given", () => {
  assert.equal(fullConfig({ owner: "Sam" }).gate.requireUpdatedAt, false);
  assert.deepEqual(checkConfig({ owner: "Sam", gate: { requireUpdatedAt: "yes" } }).filter((p) => /requireUpdatedAt/.test(p)), ["gate.requireUpdatedAt: true or false"]);
  assert.deepEqual(checkConfig({ owner: "Sam", gate: { requireUpdatedAt: true } }).filter((p) => /requireUpdatedAt/.test(p)), []);
});

test("updatedAt: a set or update of initiatives, waiting, ideas, threads or plan needs the clock's time, within 4 minutes; off, nothing changes", () => {
  assert.deepEqual(STAMPED, ["initiatives", "waiting", "ideas", "threads", "plan"]);
  for (const c of STAMPED) {
    assert.match(updatedAtErrors(w("update", c, "x", { text: "t" }), NOW)[0], /add updatedAt \(ms, read the clock/, c);
    assert.deepEqual(updatedAtErrors(w("update", c, "x", { text: "t", updatedAt: NOW - 1000 }), NOW), [], c);
    assert.deepEqual(updatedAtErrors(w("set", c, "x", { text: "t", updatedAt: NOW - 1000 }), NOW), [], c);
  }
  assert.match(updatedAtErrors(w("update", "waiting", "x", { updatedAt: NOW - 5 * 60e3 }), NOW)[0], /more than 4 minutes old/);
  assert.deepEqual(updatedAtErrors(w("update", "waiting", "x", { updatedAt: NOW - 3 * 60e3 }), NOW), [], "3 minutes is inside the window");
  assert.match(updatedAtErrors(w("update", "waiting", "x", { updatedAt: "now" }), NOW)[0], /add updatedAt/);
  assert.match(updatedAtErrors(w("update", "waiting", "x", { updatedAt: NOW - 5.5 }), NOW)[0], /add updatedAt/, "a whole number");
  for (const c of ["steps", "messages", "ctx", "meta", "derived"]) assert.deepEqual(updatedAtErrors(w("update", c, "x", { text: "t" }), NOW), [], `${c} has its own at or none`);
  assert.deepEqual(writeErrors(w("update", "waiting", "x", { text: "t" }), { config: cfg(false), who, now: NOW }).filter((m) => /updatedAt/.test(m)), [], "off: as before");
  assert.ok(writeErrors(w("update", "waiting", "x", { text: "t" }), { config: cfg(true), who, now: NOW }).some((m) => /add updatedAt/.test(m)), "on: through writeErrors, for every role");
  assert.ok(writeErrors(w("update", "waiting", "x", { text: "t" }), { config: cfg(true), who: { role: "Manager", manager: true }, now: NOW }).some((m) => /add updatedAt/.test(m)), "the lead too");
});

test("updatedAt: a delete of those collections is refused and names the tombstone; a tombstone passes, deleted:false does not", () => {
  const e = updatedAtErrors(w("delete", "waiting", "x"), NOW);
  assert.match(e[0], /don't delete it; update it with \{deleted: true, updatedAt/);
  assert.deepEqual(updatedAtErrors(w("update", "waiting", "x", { deleted: true, updatedAt: NOW - 10 }), NOW), []);
  assert.match(updatedAtErrors(w("update", "waiting", "x", { deleted: false, updatedAt: NOW - 10 }), NOW)[0], /deleted is true or left out/);
  assert.deepEqual(updatedAtErrors(w("delete", "steps", "x"), NOW), [], "steps keep their own rule (only the lead deletes them)");
  const batch = checkWrites([w("update", "waiting", "a", { text: "ok", updatedAt: NOW - 5 }), w("update", "waiting", "b", { text: "no stamp" })], { config: cfg(true), who, now: NOW, state: {}, mirror: null });
  assert.ok(JSON.stringify(batch).includes("add updatedAt"), "one bad write refuses the batch");
});

test("updatedAt is in the gate's time checks: a time in the future or a rounded one is refused like at and since", () => {
  const e = writeErrors(w("update", "waiting", "x", { text: "t", updatedAt: NOW + 3600e3 }), { config: cfg(true), who, now: NOW });
  assert.ok(e.some((m) => /updatedAt is in the future/.test(m)), e.join("|"));
});
