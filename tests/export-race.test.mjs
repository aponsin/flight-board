// The gate's view of the board while an export is under way (c226-iphone-test, 2026-10-26: the lead's messages into a
// thread were refused while its item and thread existed). An export lists one collection after another over a minute
// or more; a write between two of them is in neither the first collection's files nor, before this fix, the journal's
// overlay, which took only writes newer than the export's newest file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMirror, withJournal } from "../gate/gate.mjs";
import { threadErrors } from "../gate/rules.mjs";

const T = 1_793_000_000_000, MIN = 60e3;

// A mirror whose collections were listed at the given times: { collection: [at, [docs]] }.
function mirrorAt(cols) {
  const dir = mkdtempSync(join(tmpdir(), "fb-race-"));
  for (const [c, [at, docs]] of Object.entries(cols)) {
    mkdirSync(join(dir, c));
    for (const d of docs) {
      const f = join(dir, c, `${d.id}.json`);
      writeFileSync(f, JSON.stringify({ ...d, id: undefined }));
      utimesSync(f, at / 1000, at / 1000);
    }
  }
  return dir;
}

test("a write made while the export ran, after its collection was listed, is laid over the mirror", () => {
  // waiting listed at T, the ask and its thread written at T+1 min, threads and messages listed at T+2 min.
  const dir = mirrorAt({
    initiatives: [T, [{ id: "c226", status: "active" }]],
    ideas: [T, [{ id: "idea-1" }]],
    waiting: [T, [{ id: "older-ask", kind: "action", since: T - 9 * MIN }]],
    threads: [T + 2 * MIN, [{ id: "older-ask", num: 1, title: "Older" }, { id: "c226-iphone-test", num: 2, title: "iPhone test" }]],
    messages: [T + 2 * MIN, [{ id: "m0", thread: "older-ask", from: "Sam", text: "hi", at: T - 5 * MIN }]],
  });
  try {
    const m = readMirror(dir);
    const journal = [
      { op: "set", collection: "waiting", doc_id: "c226-iphone-test", data: { kind: "action", since: T + MIN, text: "Test on your iPhone" }, at: T + MIN },
      { op: "set", collection: "threads", doc_id: "c226-iphone-test", data: { num: 2, title: "iPhone test" }, at: T + MIN },
    ];
    const seen = withJournal(m, journal);
    assert.ok(seen.docs.waiting.some((d) => d.id === "c226-iphone-test"), "the ask written after waiting was listed");
    const msg = { op: "set", collection: "messages", doc_id: "m1", data: { thread: "c226-iphone-test", from: "Manager", text: "Here is how", at: T + 3 * MIN } };
    assert.deepEqual(threadErrors(msg, { mirror: seen, now: T + 3 * MIN }), [], "the lead's message into its thread passes");
    // A write older than its collection's listing is already in the export: not laid again (an owner's later change
    // the export holds is never undone by an older journal entry).
    const old = withJournal(m, [{ op: "set", collection: "threads", doc_id: "older-ask", data: { num: 1, title: "Stale" }, at: T + MIN }]);
    assert.equal(old.docs.threads.find((d) => d.id === "older-ask").title, "Older");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("each collection keeps when it was listed; one the export didn't hold takes the export's newest time", () => {
  const dir = mirrorAt({ waiting: [T, [{ id: "a" }]], threads: [T + 2 * MIN, [{ id: "a", num: 1, title: "A" }]] });
  try {
    const m = readMirror(dir);
    assert.equal(m.atBy.waiting, T);
    assert.equal(m.atBy.threads, T + 2 * MIN);
    assert.equal(m.at, T + 2 * MIN, "the age check still reads the newest file");
    const seen = withJournal(m, [{ op: "set", collection: "ideas", doc_id: "i1", data: { text: "x" }, at: T + MIN }]);
    assert.deepEqual(seen.docs.ideas, [{ id: "i1", text: "x" }], "#C347: a document the export doesn't hold takes its write, whenever it was made");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
