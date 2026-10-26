// Every thread has its number from the start (thread-num-always): the gate's rule (gate/rules.mjs threadNumberedErrors,
// through mirrorErrors), the backfill (scripts/thread-ids.mjs), and the page's tag and badges. Fictional board.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { mirrorErrors, threadNumberedErrors } from "../gate/rules.mjs";
import { allocate } from "../scripts/thread-ids.mjs";
import { loadNames, renderWaitingHtml } from "./harness.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const T = 1_800_000_000_000;
const mirror = (over = {}) => ({ docs: { initiatives: [], waiting: [{ id: "w-old" }, { id: "w-legacy" }], ideas: [], messages: [], derived: [], threads: [{ id: "w-old", num: 4, title: "Old ask" }, { id: "w-bare" }], ...over } });
const set = (collection, id, data) => ({ op: "set", collection, doc_id: id, data });
const has = (errs, part) => assert.ok(errs.some((e) => e.includes(part)), `"${part}" in: ${errs.join(" | ")}`);

test("a new waiting item comes with its numbered thread in the same batch; one already on the board needs nothing", () => {
  const item = set("waiting", "w-new", { kind: "decision", text: "Pick one", since: T });
  has(mirrorErrors(item, { config, mirror: mirror(), batch: [item] }), "thread w-new has no number yet");
  const numbered = [item, set("threads", "w-new", { num: 5, title: "Pick one" }), { op: "update", collection: "meta", doc_id: "threadSeq", data: { next: 6 }, if_version: 3 }];
  assert.deepEqual(mirrorErrors(item, { config, mirror: mirror(), batch: numbered }), []);
  has(mirrorErrors(item, { config, mirror: mirror(), batch: [item, set("threads", "w-new", { num: 5 })] }), "has no number yet", "a title too");
  assert.deepEqual(mirrorErrors({ op: "update", collection: "waiting", doc_id: "w-old", data: { done: true } }, { config, mirror: mirror() }), [], "an update to an item on the board");
  assert.deepEqual(mirrorErrors(set("waiting", "w-old", { text: "again" }), { config, mirror: mirror() }), [], "a set over an item on the board");
  assert.deepEqual(mirrorErrors(set("waiting", "w-legacy", { text: "again" }), { config, mirror: mirror() }), [], "an item from before, not numbered yet: still editable (the backfill numbers it)");
  assert.deepEqual(threadNumberedErrors(item, { mirror: { docs: { waiting: [] } }, batch: [item] }), [], "no threads in the export: skipped");
});

test("a message opening a thread the board hasn't numbered comes with its number; the owner's own new thread is left to the lead", () => {
  const reply = (thread) => set("messages", `m-${thread}`, { thread, from: "Manager", text: "Done.", at: T });
  assert.deepEqual(threadNumberedErrors(reply("w-old"), { mirror: mirror(), batch: [] }), [], "a numbered thread");
  has(threadNumberedErrors(reply("w-bare"), { mirror: mirror(), batch: [] }), "thread w-bare has no number yet");
  const fill = { op: "update", collection: "threads", doc_id: "w-bare", data: { num: 5, title: "Bare" } };
  assert.deepEqual(threadNumberedErrors(reply("w-bare"), { mirror: mirror(), batch: [fill] }), []);
  assert.deepEqual(threadNumberedErrors(reply(`t-${T}`), { mirror: mirror(), batch: [] }), [], "the owner's t-<time> thread: the backfill numbers it");
});

test("the backfill numbers waiting items too (opened at their since), names each from its text, and keeps every number", () => {
  const { batches, first, next } = allocate({
    threads: [{ id: "w-old", num: 4, title: "Old ask" }, { id: "w-bare" }],
    messages: [{ thread: "t-1", at: T + 5, text: "A question from the owner" }],
    waiting: [{ id: "w-old", since: T, text: "Old" }, { id: "w-bare", since: T + 1, text: "Bare ask" }, { id: "w-new", since: T + 9, text: "x".repeat(200) }],
    seq: { next: 5 },
  });
  assert.deepEqual([first, next], [5, 8]);
  assert.deepEqual(batches[0], [
    { op: "update", collection: "threads", doc_id: "w-bare", data: { num: 5, title: "Bare ask" } },
    { op: "set", collection: "threads", doc_id: "t-1", data: { num: 6, title: "A question from the owner" } },
    { op: "set", collection: "threads", doc_id: "w-new", data: { num: 7, title: `${"x".repeat(119)}…` } },
    { op: "update", collection: "meta", doc_id: "threadSeq", data: { next: 8 } },
  ]);
});

test("the page: every item and thread shows #T<num> · title, and who it waits on", () => {
  const b = loadNames(["askHtml"]);
  const w = { id: "w-old", kind: "decision", text: "Pick one", since: T };
  Object.assign(b.state, { threads: [{ id: "w-old", num: 4, title: "Old ask" }], waiting: [w], messages: [] });
  const html = b.askHtml(w, new Set());
  assert.match(html, /class="t-tag"><button type="button" class="copy t-num" data-copy="#T4"[^>]*>#T4<\/button> · <b class="t-name">Old ask<\/b>/);
  assert.match(html, /<span class="t-badge you">waiting on you<\/span>/);
});

test("a badge never breaks across lines (the owner's screenshot: \"waiting on / Manager\")", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(html, /\.t-badge\{[^}]*white-space:nowrap[^}]*\}/);
});
