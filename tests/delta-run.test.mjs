import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeRun, scratchRoot, EXPORT_NAME } from "../collector/collect.mjs";
import { MUTABLE, OVERLAP_MS, SWEEP_STAGES, readStamp, readDeltaState, writeDeltaState, writeStamp, deriveDue, deriveLines, saveLines, DERIVE_EVERY_MS, DERIVE_FILE } from "../collector/delta.mjs";
import { readMirror, TOMBSTONED } from "../gate/gate.mjs";
import { writeErrors, checkWrites, updatedAtErrors, STAMPED, STAMP_WINDOW_MS, isDeletion } from "../gate/rules.mjs";
import { linesOf, linesPending, linesSeen, LINES_MAX, LINE_MAX } from "../gate/reset.mjs";
import { tick } from "../scripts/wake-watch.mjs";
import { fullConfig, checkConfig } from "../scripts/config.mjs";

const NOW = 1_793_735_000_000 + 4321;
const uid = process.getuid();
const put = (root, c, id, doc) => { mkdirSync(join(root, c), { recursive: true }); writeFileSync(join(root, c, `${id}.json`), JSON.stringify(doc)); };
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

// A board folder, its scratch root (the Collector runs in the board folder, so its scratchpads sit under it) and a run's export.
// The run saves pages (<collection>/q1.page.json for a delta, sweep/<collection>/p1.page.json for a sweep page), the sweep
// report and the seal; the probe cuts the pages into documents.
const pageFile = (exp, rel, docs) => { mkdirSync(join(exp, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(exp, ...rel.split("/")), JSON.stringify({ docs: Object.entries(docs).map(([id, data]) => ({ id, data })) })); };
function board() {
  const base = mkdtempSync(join(tmpdir(), "c655-"));
  const dir = join(base, "state", "Board01");
  mkdirSync(dir, { recursive: true });
  const root = scratchRoot(dir, uid, join(base, "tmp"));
  // sweep: the mark's page ({startedAt, fresh, stage, cursor}); pageDocs: what that page holds; next: the report's cursor.
  const run = (name, { mode = "delta", at, docs = {}, sweep = null, pageDocs = {}, next = null, seal = true }) => {
    const collection = sweep ? SWEEP_STAGES[sweep.stage].collection : null;
    writeFileSync(join(dir, "export-since.json"), JSON.stringify({ at, refs: {}, mode, sweep: sweep ? { fresh: false, cursor: null, ...sweep, collection, limit: 1 } : null }));
    const exp = join(root, name, "scratchpad", EXPORT_NAME);
    mkdirSync(exp, { recursive: true });
    for (const [c, list] of Object.entries(docs)) pageFile(exp, `${c}/q1.page.json`, list);
    if (sweep) { pageFile(exp, `sweep/${collection}/p1.page.json`, pageDocs); writeFileSync(join(exp, "sweep-next.json"), JSON.stringify({ collection, next })); }
    if (seal) put(exp, "derived", "all", { version: null });
    return exp;
  };
  return { base, dir, root, run, merge: (now = NOW) => mergeRun({ dir, id: "Board01", uid, now, base: join(base, "tmp") }), done: () => rmSync(base, { recursive: true, force: true }) };
}
const stageName = (i) => SWEEP_STAGES[i].collection;

test("mergeRun: a sweep seeds the mirror page by page, with the deltas laid over its pages; the board is the mirror only when the last page is in", async () => {
  const b = board();
  try {
    const t0 = NOW - 7200e3, tick = (n) => t0 + n * 60e3;
    put(join(b.dir, "sweep"), "initiatives", "left-over", { name: "an earlier sweep" });
    // Run 1 starts the sweep (no mirror, no delta): the first page of initiatives holds a and b, and says more follow.
    b.run("r1", { mode: "sweep", at: tick(0), sweep: { startedAt: tick(0), fresh: true, stage: 0 }, pageDocs: { a: { name: "a-page" }, b: { name: "b" } }, next: "k1" });
    const one = b.merge(tick(1));
    assert.equal(one.did, "sweep");
    assert.equal(existsSync(join(b.dir, "mirror")), false, "no mirror until the sweep is whole");
    assert.equal(read(join(b.dir, "sweep", "initiatives", "a.json")).name, "a-page");
    assert.equal(existsSync(join(b.dir, "sweep", "initiatives", "left-over.json")), false, "a new sweep starts from an empty staging folder");
    assert.deepEqual(readDeltaState(b.dir), { at: tick(0), fullAt: null, lastPrepare: tick(0), sweep: { startedAt: tick(0), stage: 0, cursor: "k1", runs: 1 } });
    assert.equal(b.merge(tick(1)).did, null, "the same run is never merged twice");
    // Run 2: the page at k1 ends initiatives; a delta says a changed after its page was read (the delta wins).
    await new Promise((r) => setTimeout(r, 15));
    b.run("r2", { mode: "sweep", at: tick(1), docs: { initiatives: { a: { name: "a-delta", updatedAt: tick(1) } } }, sweep: { startedAt: tick(0), stage: 0, cursor: "k1" }, pageDocs: { a: { name: "a-page-older" }, c: { name: "c" } }, next: null });
    assert.equal(b.merge(tick(2)).did, "sweep");
    assert.equal(read(join(b.dir, "sweep", "initiatives", "a.json")).name, "a-delta");
    assert.deepEqual(readDeltaState(b.dir).sweep, { startedAt: tick(0), stage: 1, cursor: null, runs: 2 });
    // The rest of the stages, one page each; the last is the steps. A tombstone on a page is not kept.
    for (let s = 1; s < SWEEP_STAGES.length; s++) {
      await new Promise((r) => setTimeout(r, 15));
      const last = s === SWEEP_STAGES.length - 1;
      b.run(`r${s + 2}`, { mode: "sweep", at: tick(s + 1), sweep: { startedAt: tick(0), stage: s }, pageDocs: { [`d${s}`]: { n: s }, gone: { deleted: true, updatedAt: s } }, next: null });
      const out = b.merge(tick(s + 2));
      assert.equal(out.did, "sweep");
      if (!last) assert.equal(existsSync(join(b.dir, "mirror")), false);
    }
    // The whole board is the mirror now: every stage's page, no staging folder, no tombstone, a stamp, a state without a sweep.
    assert.equal(existsSync(join(b.dir, "sweep")), false);
    assert.equal(read(join(b.dir, "mirror", "initiatives", "a.json")).name, "a-delta");
    assert.equal(read(join(b.dir, "mirror", "initiatives", "c.json")).name, "c");
    for (let s = 1; s < SWEEP_STAGES.length; s++) {
      assert.equal(read(join(b.dir, "mirror", stageName(s), `d${s}.json`)).n, s);
      // Only the collections edited in place have tombstones (steps, messages and ctx keep every document as written).
      assert.equal(existsSync(join(b.dir, "mirror", stageName(s), "gone.json")), !MUTABLE.includes(stageName(s)), `${stageName(s)}: a tombstone is not kept`);
    }
    assert.equal(existsSync(join(b.dir, "mirror", "derived")), false, "the probe's derive makes derived/all, the seal is not a document");
    const end = tick(SWEEP_STAGES.length);
    assert.deepEqual(readStamp(join(b.dir, "mirror")), { at: end, mergedAt: tick(SWEEP_STAGES.length + 1) });
    assert.deepEqual(readDeltaState(b.dir), { at: end, fullAt: tick(0), lastPrepare: end, sweep: null });
    // The next run is a delta over the mirror.
    await new Promise((r) => setTimeout(r, 15));
    b.run("rd", { at: end + 60e3, docs: { initiatives: { a: { name: "a2", updatedAt: end + 1 }, c: { deleted: true, updatedAt: end + 2 } } } });
    const delta = b.merge(end + 120e3);
    assert.equal(delta.did, "delta");
    assert.equal(read(join(b.dir, "mirror", "initiatives", "a.json")).name, "a2");
    assert.equal(existsSync(join(b.dir, "mirror", "initiatives", "c.json")), false);
    assert.equal(delta.removed, 1);
    assert.equal(existsSync(join(b.dir, "sweep")), false, "no sweep going: no staging folder");
  } finally { b.done(); }
});

test("mergeRun: an export without its seal is not merged (the run is still reading); a mark with no mode, or mode off, never counts", () => {
  const b = board();
  try {
    writeDeltaState(b.dir, { at: NOW - 7200e3, fullAt: NOW - 7200e3, lastPrepare: NOW - 7200e3 });
    mkdirSync(join(b.dir, "mirror", "initiatives"), { recursive: true });
    b.run("half", { at: NOW - 1800e3, docs: { steps: { s: { at: NOW - 1700e3 } } }, seal: false });
    assert.equal(b.merge().did, null, "derived/all.json is saved last: not there yet");
    put(join(b.root, "half", "scratchpad", EXPORT_NAME), "derived", "all", { version: 2 });
    assert.equal(b.merge().did, "delta");
    // A mark with no mode (the older run) is left to collect.mjs's own step; mode off reads nothing.
    for (const mode of ["off", "full"]) {
      const exp = b.run(`m-${mode}`, { mode, at: NOW - 600e3, docs: { initiatives: { x: { name: "x" } } } });
      assert.equal(b.merge().did, null, `a sealed export marked ${mode}`);
      assert.equal(existsSync(join(b.dir, "mirror", "initiatives", "x.json")), false);
      assert.equal(existsSync(exp), true);
    }
    writeFileSync(join(b.dir, "export-since.json"), JSON.stringify({ at: NOW - 600e3, refs: {} }));
    assert.equal(b.merge().did, null);
  } finally { b.done(); }
});

test("mergeRun: a sweep that ends over a mirror the deltas built prints MIRROR DRIFT for what they missed, and then replaces the mirror", () => {
  const b = board();
  try {
    const t0 = NOW - 7200e3, last = SWEEP_STAGES.length - 1;
    mkdirSync(join(b.dir, "mirror", "initiatives"), { recursive: true });
    put(join(b.dir, "mirror"), "initiatives", "ok", { name: "ok", updatedAt: 1 });
    put(join(b.dir, "mirror"), "initiatives", "stale", { name: "stale" });
    put(join(b.dir, "mirror"), "initiatives", "hard-deleted", { name: "gone" });
    put(join(b.dir, "mirror"), "waiting", "w", { text: "w" });
    writeStamp(join(b.dir, "mirror"), t0, t0);
    writeDeltaState(b.dir, { at: t0, fullAt: t0 - 4 * 86400e3, lastPrepare: t0, sweep: { startedAt: t0, stage: last, cursor: null, runs: 40 } });
    // The staging folder holds the earlier pages: the board as the sweep read it.
    put(join(b.dir, "sweep"), "initiatives", "ok", { name: "ok", updatedAt: 1 });
    put(join(b.dir, "sweep"), "initiatives", "stale", { name: "edited by a writer with no stamp" });
    put(join(b.dir, "sweep"), "waiting", "w", { text: "w" });
    b.run("end", { mode: "sweep", at: NOW - 600e3, sweep: { startedAt: t0, stage: last }, pageDocs: { s1: { at: NOW } }, next: null });
    const out = b.merge();
    assert.equal(out.did, "sweep");
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0], /^MIRROR DRIFT initiatives: changed with no newer updatedAt 1 \(stale\); deleted on the board, still in the mirror 1 \(hard-deleted\)/);
    assert.equal(read(join(b.dir, "mirror", "initiatives", "stale.json")).name, "edited by a writer with no stamp", "the sweep is the mirror now");
    assert.equal(existsSync(join(b.dir, "mirror", "initiatives", "hard-deleted.json")), false);
    assert.equal(existsSync(join(b.dir, "sweep")), false);
    assert.equal(readDeltaState(b.dir).fullAt, t0, "a sweep is dated by its start");
    assert.equal(readDeltaState(b.dir).sweep, null);
    assert.equal(readStamp(join(b.dir, "mirror")).at, NOW - 600e3);
  } finally { b.done(); }
});

test("a sweep holding a tombstone: mergeRun leaves it out of the mirror, and readMirror shows no card for it (Checker)", () => {
  const b = board();
  try {
    const last = SWEEP_STAGES.length - 1;
    writeDeltaState(b.dir, { at: NOW - 900e3, fullAt: null, lastPrepare: NOW - 900e3, sweep: { startedAt: NOW - 900e3, stage: last, cursor: null, runs: 9 } });
    put(join(b.dir, "sweep"), "initiatives", "live", { name: "live", updatedAt: 1 });
    put(join(b.dir, "sweep"), "initiatives", "dead", { deleted: true, updatedAt: 2 });
    put(join(b.dir, "sweep"), "waiting", "gone", { deleted: true, updatedAt: 3 });
    put(join(b.dir, "sweep"), "plan", "p", { deleted: true, updatedAt: 4 });
    b.run("end", { mode: "sweep", at: NOW - 600e3, sweep: { startedAt: NOW - 900e3, stage: last }, pageDocs: { x: { at: NOW } }, next: null });
    assert.equal(b.merge().did, "sweep");
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

test("mergeRun: a delta marked while no mirror exists takes nothing and writes no state (it would otherwise pass as the whole board)", () => {
  const b = board();
  try {
    const t1 = NOW - 600e3;
    const exp = b.run("lonely", { mode: "delta", at: t1, docs: { initiatives: { a: { name: "a", updatedAt: t1 } } } });
    assert.equal(b.merge().did, null);
    assert.equal(existsSync(join(b.dir, "mirror")), false, "no mirror made from a delta");
    assert.equal(existsSync(join(b.dir, "sweep")), false);
    assert.equal(readDeltaState(b.dir), null, "no state, so the next run plans a sweep");
    assert.equal(existsSync(exp), true, "the export is left where it was");
  } finally { b.done(); }
});

test("mergeRun: a delta while a sweep goes lands in the mirror and in the staging folder; a page that is not the planned one is not laid", () => {
  const b = board();
  try {
    const t0 = NOW - 3600e3;
    mkdirSync(join(b.dir, "mirror", "initiatives"), { recursive: true });
    put(join(b.dir, "mirror"), "initiatives", "m", { name: "m", updatedAt: 1 });
    writeStamp(join(b.dir, "mirror"), t0, t0);
    writeDeltaState(b.dir, { at: t0, fullAt: t0 - 99e6, lastPrepare: t0, sweep: { startedAt: t0 - 600e3, stage: 0, cursor: "k1", runs: 1 } });
    // A run whose page is for another cursor (the state moved on): its delta counts, its page does not, and the sweep stays.
    b.run("odd", { mode: "sweep", at: NOW - 900e3, docs: { initiatives: { n: { name: "n", updatedAt: NOW - 950e3 } } }, sweep: { startedAt: t0 - 600e3, stage: 0, cursor: "k0" }, pageDocs: { stray: { name: "stray" } }, next: null });
    assert.equal(b.merge().did, "delta");
    assert.equal(read(join(b.dir, "mirror", "initiatives", "n.json")).name, "n");
    assert.equal(read(join(b.dir, "sweep", "initiatives", "n.json")).name, "n");
    assert.equal(existsSync(join(b.dir, "sweep", "initiatives", "stray.json")), false, "not the planned page");
    assert.deepEqual(readDeltaState(b.dir).sweep, { startedAt: t0 - 600e3, stage: 0, cursor: "k1", runs: 2 });
    // A run of another collection's report is not laid either.
    b.run("odd2", { mode: "sweep", at: NOW - 300e3, sweep: { startedAt: t0 - 600e3, stage: 0, cursor: "k1" }, pageDocs: { stray2: {} }, next: "k2" });
    writeFileSync(join(b.root, "odd2", "scratchpad", EXPORT_NAME, "sweep-next.json"), JSON.stringify({ collection: "waiting", next: "k2" }));
    b.merge();
    assert.equal(existsSync(join(b.dir, "sweep", "initiatives", "stray2.json")), false);
    assert.equal(readDeltaState(b.dir).sweep.cursor, "k1", "the cursor did not move");
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

test("a tombstone is a delete for every rule that guards a delete (Security): a role can't remove a card or a thread with {deleted: true}", () => {
  const manager = { role: "Manager", manager: true };
  const tomb = (collection, id, extra = {}) => w("update", collection, id, { deleted: true, updatedAt: NOW - 10, ...extra });
  const errs = (write, by) => writeErrors(write, { config: cfg(true), who: by, now: NOW }).join("|");
  // isDeletion: a delete, or a set/update with deleted: true in a collection edited in place; nothing else.
  assert.equal(isDeletion(w("delete", "steps", "x")), true);
  assert.equal(isDeletion(tomb("initiatives", "c")), true);
  assert.equal(isDeletion(w("set", "threads", "t", { deleted: true, updatedAt: NOW })), true);
  for (const write of [w("update", "initiatives", "c", { deleted: false, updatedAt: NOW }), w("update", "initiatives", "c", { text: "t" }), w("update", "steps", "s", { deleted: true }), w("update", "initiatives", "c")]) assert.equal(isDeletion(write), false, JSON.stringify(write));
  // A card: only the lead deletes it, so only the lead tombstones it.
  assert.match(errs(tomb("initiatives", "card-one"), who), /only Manager deletes a card/);
  assert.doesNotMatch(errs(tomb("initiatives", "card-one"), manager), /deletes a card/);
  assert.doesNotMatch(errs(w("update", "initiatives", "card-one", { text: "t", updatedAt: NOW - 10 }), who), /deletes a card/, "an ordinary update is untouched");
  // A thread: its number is kept for good, for the lead too; others may not touch it at all.
  assert.match(errs(tomb("threads", "t-1"), manager), /a thread number is kept for good/);
  assert.match(errs(tomb("threads", "t-1"), who), /only Manager numbers and names threads/);
  assert.doesNotMatch(errs(w("update", "threads", "t-1", { title: "renamed", updatedAt: NOW - 10 }), manager), /kept for good/, "a rename is untouched");
  // The plan is never deleted.
  assert.match(errs(tomb("plan", "n1"), manager), /never deleted/);
  // The ideas and waiting collections keep their own rules (anyone may drop an ask nobody answered).
  assert.doesNotMatch(errs(tomb("ideas", "i"), who), /deletes a card|kept for good|never deleted/);
});

test("updatedAt is in the gate's time checks:a time in the future or a rounded one is refused like at and since", () => {
  const e = writeErrors(w("update", "waiting", "x", { text: "t", updatedAt: NOW + 3600e3 }), { config: cfg(true), who, now: NOW });
  assert.ok(e.some((m) => /updatedAt is in the future/.test(m)), e.join("|"));
});
