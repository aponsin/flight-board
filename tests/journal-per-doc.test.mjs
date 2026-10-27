// The gate's journal is laid over the mirror document by document (#C347, the Director's card): a write the gate let
// through is folded in unless the mirror holds that same document listed at or after it. The collection's newest file
// no longer decides: a later file anywhere in the folder hid Checker's 22:20 end step, and a correct ship start was then
// refused three times. A file that doesn't parse (half written) moves no listing time.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { run, readMirror, withJournal } from "../gate/gate.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const MIN = 60e3;
const file = (dir, c, id, data, at) => {
  mkdirSync(join(dir, c), { recursive: true });
  const p = join(dir, c, `${id}.json`);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
  utimesSync(p, at / 1000, at / 1000);
};

test("the exact case: Checker's end step, journaled before a later file in steps, is on the board the gate sees; the ship start passes", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-journal-"));
  try {
    const now = Date.now(), board = join(root, "TestBoard01"), m = join(board, "mirror");
    const config = fullConfig({ artifactUrl: URL_, gate: { stateDir: root } });
    file(m, "initiatives", "x", { name: "X", status: "active", phase: "checker", who: "Checker" }, now - 20 * MIN);
    file(m, "steps", "x-checker-start", { init: "x", phase: "checker", who: "Checker", kind: "start", at: now - 30 * MIN }, now - 20 * MIN);
    file(m, "steps", "y-build-start", { init: "y", phase: "build", who: "Builder", kind: "start", at: now - 6 * MIN }, now - 5 * MIN);
    const end = { op: "set", collection: "steps", doc_id: "x-checker-end", data: { init: "x", phase: "checker", who: "Checker", kind: "end", at: now - 10 * MIN + 1234 }, at: now - 10 * MIN };
    writeFileSync(join(board, "gate.json"), JSON.stringify({ journal: [end] }));
    const transcript = join(root, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Release" }) + "\n");
    const ship = { tool_name: "ArtifactData", transcript_path: transcript, tool_input: { url: URL_, action: "set", collection: "steps", doc_id: "x-ship-start", data: { init: "x", phase: "ship", who: "Release", kind: "start", at: now - 1234 } } };
    assert.deepEqual(run(ship, { config, env: {}, now }), {}, "the end step is seen: nothing is open");
    const seen = withJournal(readMirror(m), [end]);
    assert.ok(seen.docs.steps.some((d) => d.id === "x-checker-end"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("per document: a mirror copy listed after the write wins; one listed before it is overlaid; an absent one is added", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-journal-"));
  try {
    const now = Date.now(), m = join(root, "mirror");
    file(m, "initiatives", "fresh", { status: "done" }, now - 2 * MIN);
    file(m, "initiatives", "stale", { status: "active" }, now - 20 * MIN);
    const mirror = readMirror(m);
    const out = withJournal(mirror, [
      { op: "update", collection: "initiatives", doc_id: "fresh", data: { status: "active" }, at: now - 10 * MIN },
      { op: "update", collection: "initiatives", doc_id: "stale", data: { status: "done" }, at: now - 10 * MIN },
      { op: "set", collection: "initiatives", doc_id: "new", data: { status: "active" }, at: now - 30 * MIN },
      { op: "update", collection: "initiatives", doc_id: "new", data: { phase: "build" }, at: now - 29 * MIN },
      { op: "delete", collection: "initiatives", doc_id: "gone", at: now - 30 * MIN },
    ]).docs.initiatives;
    const by = Object.fromEntries(out.map((d) => [d.id, d]));
    assert.equal(by.fresh.status, "done", "the mirror listed it after the write");
    assert.equal(by.stale.status, "done", "the write is newer than the mirror's copy");
    assert.deepEqual(by.new, { id: "new", status: "active", phase: "build" }, "absent from the mirror: the write and its update both count");
    assert.equal(by.gone, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a file that doesn't parse moves no listing time", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-journal-"));
  try {
    const now = Date.now(), m = join(root, "mirror");
    file(m, "steps", "a", { kind: "start" }, now - 20 * MIN);
    file(m, "steps", "half", "{\"kind\":", now - 1 * MIN);
    const mirror = readMirror(m);
    assert.equal(Math.round(mirror.atBy.steps), Math.round(now - 20 * MIN));
    assert.equal(Math.round(mirror.at), Math.round(now - 20 * MIN));
    assert.deepEqual(mirror.docs.steps.map((d) => d.id), ["a"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
