// Board accuracy (#C428). (1) The Collector's NUDGE listed 85 threads "with no number", numbered ones among them: each
// export list returned one page of 1000 documents, by id, so the threads (and messages) past it were missing, and a
// thread its messages name with no threads/<id> in the export read as unnumbered. The task now pages every list; a
// collection with exactly a full page says the export may be cut, and the unnumbered line waits for a whole one.
// (2), the idle rule, now in the agent tiles: tests/live-source.test.mjs.
// (state.mjs's one retry is in board-state.test.mjs, next to its POST.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unnumberedLine, unnumberedThreads, cutCollections, cutLine, EXPORT_PAGE, EXPORT_COLLECTIONS } from "../collector/collect.mjs";

const T = Date.UTC(2026, 9, 29, 4, 0);
const thread = (id, num) => ({ id, num, title: id });
const msg = (thread, at) => ({ id: `m-${at}`, thread, from: "Manager", at, text: "x" });

test("a numbered thread is never listed: with its threads doc, or with only its messages and a waiting item", () => {
  const docs = {
    threads: [thread("watchdog-cp", 1082), thread("watchdog-stuck-run", 1089)],
    messages: [msg("watchdog-cp", T), msg("watchdog-stuck-run", T + 1), msg("new-one", T + 2)],
    waiting: [{ id: "watchdog-cp", since: T - 1, text: "x" }],
  };
  assert.deepEqual(unnumberedThreads(docs), ["new-one"]);
  assert.match(unnumberedLine(docs), /^NUDGE 1 thread\(s\) with no number: new-one\./);
  assert.equal(unnumberedLine({ ...docs, messages: docs.messages.slice(0, 2) }), null, "all numbered: no line");
});

// The bug as it was: 1000 threads exported, watchdog-cp (#T1082) past the page, its messages in it.
test("a cut export (a full page of threads) gives the cut line, never a list of numbered threads as unnumbered", () => {
  const threads = Array.from({ length: EXPORT_PAGE }, (_, k) => thread(`a-${String(k).padStart(4, "0")}`, k + 1));
  const docs = { initiatives: [{ id: "c" }], threads, messages: [msg("watchdog-cp", T), msg("watchdog-stuck-run", T + 1)], waiting: [] };
  assert.deepEqual(unnumberedThreads(docs), ["watchdog-cp", "watchdog-stuck-run"], "what the old line listed");
  assert.equal(unnumberedLine(docs), null);
  assert.deepEqual(cutCollections(docs), ["threads"]);
  assert.match(cutLine(docs), /^NUDGE the board export may be cut: threads \(1000\) came back with exactly a full page; each list must be read again with its next_cursor/);
  // Once the task pages, the same board is whole: the numbered ones are not listed.
  const whole = { ...docs, threads: [...threads, thread("watchdog-cp", 1082), thread("watchdog-stuck-run", 1089)] };
  assert.deepEqual([cutLine(whole), unnumberedLine(whole)], [null, null]);
});

test("the cut check: a whole number of pages of any exported collection, none for an empty or a partial one", () => {
  const page = (n) => Array.from({ length: n }, (_, k) => ({ id: `d${k}` }));
  assert.deepEqual(cutCollections({ messages: page(1000), waiting: page(994), steps: page(3568), ctx: [] }), ["messages"]);
  assert.deepEqual(cutCollections({ messages: page(2000) }), ["messages"], "two full pages: one page short of the cursor's end");
  assert.deepEqual(cutCollections({}), []);
  assert.equal(cutLine({ threads: page(999) }), null);
  assert.match(cutLine({ messages: page(1000), threads: page(1000) }), /: messages \(1000\), threads \(1000\) came back/);
  // Cut messages or waiting items hide numbered threads as surely as cut threads: the line waits for those too.
  const loose = { threads: [], messages: [msg("new-one", T)], waiting: page(1000).map((w, k) => ({ ...w, since: T + k })) };
  assert.equal(unnumberedLine(loose), null);
  assert.ok(EXPORT_COLLECTIONS.includes("threads") && EXPORT_COLLECTIONS.includes("messages"));
});

test("the task pages every export list with next_cursor, in its steps and in its prompt", () => {
  const prompt = readFileSync(new URL("../collector/PROMPT.txt", import.meta.url), "utf8");
  const task = readFileSync(new URL("../collector/TASK.md", import.meta.url), "utf8");
  assert.match(prompt, /for each of: initiatives, waiting, ideas, messages, derived, ctx, plan, threads \([^)]*\), each again with its next_cursor \(query\.cursor, the same out_dir\) until there is none\./);
  assert.match(task, /`threads` \([^)]*\),\s+each again with its `next_cursor` \(`query\.cursor`, the same `out_dir`\) until there is none/);
  assert.match(task, /`NUDGE the board export may be cut`/);
});
