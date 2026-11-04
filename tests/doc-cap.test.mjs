// The document-cap tool (#C646): what it would archive (dry), the db_write batches for steps (A) and messages (B), the archive
// file and the restore. It reads a mirror and writes only files in an out folder; it never calls the board.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSteps, planMessages, messageOps, restoreOps, dryReport, BATCH, DAY } from "../scripts/doc-cap.mjs";

const NOW = 1_793_800_000_000;
const ago = (d) => NOW - d * DAY;
const card = (id, status, doneAt) => ({ id, status, ...(doneAt ? { doneAt } : {}) });
const step = (init, kind, at) => ({ id: `${init}-build-${kind}-${at}`, init, phase: "build", who: "A", kind, at });
const msg = (thread, n, at, over = {}) => ({ id: `${thread}-m${n}`, thread, at, from: "Manager", text: `t${n}`, ...over });

test("A: the steps of cards closed 14+ days ago become one timings document each; open and recent cards are untouched", () => {
  const cards = [card("old", "done", ago(20)), card("recent", "done", ago(3)), card("open", "active")];
  const steps = [step("old", "start", ago(21)), step("old", "end", ago(20)), step("recent", "start", ago(4)), step("open", "start", ago(30))];
  const p = planSteps({ cards, steps, now: NOW });
  assert.equal(p.cards, 1);
  assert.deepEqual([p.deleted, p.added, p.freed], [2, 1, 1]);
  const flat = p.ops.flat();
  assert.equal(flat[0].op, "set");
  assert.equal(flat[0].path, "timings/old", "the archive comes before the first delete");
  assert.deepEqual(flat[0].data.steps.map((s) => s.id), [steps[0].id, steps[1].id]);
  assert.deepEqual(flat.slice(1), steps.slice(0, 2).map((s) => ({ op: "delete", path: `steps/${s.id}`, ifVersion: 1 })));
  assert.equal(planSteps({ cards, steps, now: NOW, days: 1 }).cards, 2, "a shorter cut takes the recent card too");
});

test("A: a card already archived only loses what its timings document holds; a late step stays", () => {
  const cards = [card("old", "done", ago(20))];
  const steps = [step("old", "start", ago(21)), step("old", "end", ago(20)), step("old", "start", ago(19))];
  const timings = [{ id: "old", steps: steps.slice(0, 2) }];
  const p = planSteps({ cards, steps, timings, now: NOW });
  assert.deepEqual([p.added, p.deleted], [0, 2]);
  assert.deepEqual(p.late, [steps[2].id]);
});

test("B: a thread silent for 14+ days and tied to nothing open is archived; recent and tied threads stay", () => {
  const messages = [msg("t-old", 1, ago(30)), msg("t-old", 2, ago(29)), msg("t-new", 1, ago(40)), msg("t-new", 2, ago(2)), msg("t-ask", 1, ago(40)), msg("t-card", 1, ago(40)), msg("t-done", 1, ago(40))];
  const waiting = [{ id: "a1", done: false, text: "see thread t-ask" }, { id: "a2", done: true, text: "t-done is answered" }];
  const cards = [{ id: "c1", status: "active", summary: "Follows thread t-card" }, { id: "c2", status: "done", summary: "Follows thread t-done" }];
  const p = planMessages({ messages, waiting, cards, now: NOW });
  assert.deepEqual(p.threads, ["t-done", "t-old"], "an answered ask or a done card does not hold a thread");
  assert.deepEqual(p.kept, { recent: 1, tied: 2 });
  assert.deepEqual([p.deleted, p.added, p.freed], [3, 2, 1]);
  assert.deepEqual(p.archive["t-old"].map((m) => m.id), ["t-old-m1", "t-old-m2"], "oldest first");
});

test("B: the batches write each thread's line before its deletes, in batches of at most 49, and every delete carries ifVersion 1", () => {
  const messages = Array.from({ length: 120 }, (_, n) => msg(`t-${n % 3}`, n, ago(30) + n));
  const p = planMessages({ messages, now: NOW });
  const batches = messageOps(p, NOW);
  assert.ok(batches.every((b) => b.length <= BATCH));
  const flat = batches.flat();
  assert.equal(flat.length, 120 + 3);
  for (const tid of p.threads) {
    const line = flat.findIndex((o) => o.path === `timings/thread-${tid}`);
    const firstDelete = flat.findIndex((o) => o.op === "delete" && p.archive[tid].some((m) => o.path === `messages/${m.id}`));
    assert.ok(line >= 0 && line < firstDelete, tid);
    assert.equal(flat[line].data.archivedMessages, 40);
  }
  assert.ok(flat.filter((o) => o.op === "delete").every((o) => o.ifVersion === 1));
  assert.deepEqual(planMessages({ messages: [msg("t-x", 1, ago(2))], now: NOW }).threads, []);
});

test("restore puts every archived message back as it was and removes the line", () => {
  const messages = [msg("t-old", 1, ago(30), { kind: "building", after: "x" }), msg("t-old", 2, ago(29))];
  const p = planMessages({ messages, now: NOW });
  const file = { threads: Object.fromEntries(p.threads.map((t) => [t, p.archive[t]])) };
  const ops = restoreOps(file).flat();
  assert.deepEqual(ops.filter((o) => o.op === "set").map((o) => [o.path, o.data]), [["messages/t-old-m1", { thread: "t-old", at: ago(30), from: "Manager", text: "t1", kind: "building", after: "x" }], ["messages/t-old-m2", { thread: "t-old", at: ago(29), from: "Manager", text: "t2" }]]);
  assert.deepEqual(ops.at(-1), { op: "delete", path: "timings/thread-t-old", ifVersion: 1 });
});

test("dryReport names each piece and the days of growth it buys; the CLI writes only in the out folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-cap-"));
  try {
    const put = (c, id, doc) => { mkdirSync(join(dir, "mirror", c), { recursive: true }); writeFileSync(join(dir, "mirror", c, `${id}.json`), JSON.stringify(doc)); };
    const now = Date.now();
    put("initiatives", "old", { status: "done", doneAt: now - 20 * DAY });
    put("steps", "old-build-start-1", { init: "old", phase: "build", who: "A", kind: "start", at: now - 21 * DAY });
    put("steps", "old-build-end-2", { init: "old", phase: "build", who: "A", kind: "end", at: now - 20 * DAY });
    put("messages", "t-q-m1", { thread: "t-q", at: now - 30 * DAY, from: "Manager", text: "hi" });
    put("messages", "t-q-m2", { thread: "t-q", at: now - 29 * DAY, from: "Manager", text: "ho" });
    const script = new URL("../scripts/doc-cap.mjs", import.meta.url).pathname;
    const go = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: "utf8" });
    const dry = go("dry", join(dir, "mirror"));
    assert.match(dry.stdout, /A\. steps of closed cards: 1 card\(s\), 2 steps deleted, 1 timings added, 1 documents freed/);
    assert.match(dry.stdout, /B\. messages of quiet threads: 1 thread\(s\), 2 messages archived to a file and deleted, 1 lines added, 1 documents freed/);
    assert.match(dry.stdout, /Total freed: 2 documents/);
    assert.deepEqual(readdirSync(dir), ["mirror"], "dry writes nothing");
    const out = join(dir, "out");
    assert.equal(go("steps", join(dir, "mirror"), out).status, 0);
    const m = go("messages", join(dir, "mirror"), out);
    assert.match(m.stdout, /messages-archive-\d+\.json \(written first: keep it\)/);
    const files = readdirSync(out).sort();
    assert.ok(files.includes("steps-batch-1.json") && files.includes("messages-batch-1.json") && files.some((f) => /^messages-archive-\d+\.json$/.test(f)));
    const archive = JSON.parse(readFileSync(join(out, files.find((f) => f.startsWith("messages-archive-"))), "utf8"));
    assert.deepEqual(archive.threads["t-q"].map((x) => x.text), ["hi", "ho"]);
    assert.equal(go("restore", join(out, files.find((f) => f.startsWith("messages-archive-"))), join(dir, "back")).status, 0);
    assert.ok(readdirSync(join(dir, "back")).includes("restore-batch-1.json"));
    assert.equal(go("bogus", dir).status, 2);
    assert.equal(go().status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match(dryReport({ cards: [], steps: [], timings: [], messages: [], waiting: [], now: NOW }), /Total freed: 0 documents, about 0\.0 days/);
});
