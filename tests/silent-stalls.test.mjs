// Silent stalls (#C433: #C389 and #C400 sat open a day). (2) A lead's question to the owner in a thread reaches Needs
// you only as a waiting item: a new message of kind "question" from anyone but the owner needs an open waiting item for
// its thread, in the same batch or already on the board. (Part (1), a READY that landed with other context lines, is in
// tests/settled-tips.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { questionAskErrors, checkWrites } from "../gate/rules.mjs";

const config = fullConfig({ owner: "Sam" });
const msg = (over = {}) => ({ op: "set", collection: "messages", doc_id: "m-1", data: { thread: "t-389", from: "Manager", kind: "question", text: "Which one do you want?", at: 1, ...over } });
const ask = (over = {}) => ({ op: "set", collection: "waiting", doc_id: "t-389", data: { kind: "action", text: "Which one do you want?", since: 1, ...over } });
const mirror = (waiting = []) => ({ docs: { waiting, threads: [{ id: "t-389", num: 389, title: "x" }], messages: [], initiatives: [], steps: [] } });
const RE = /^a question to Sam reaches Needs you only as a waiting item: set waiting\/t-389 \{kind, text, since\} in the same batch/;

test("a lead's question with no waiting item is refused, naming the item to set (#C389's case)", () => {
  const w = msg();
  assert.match(questionAskErrors(w, { config, mirror: mirror(), batch: [w] })[0], RE);
  assert.match(questionAskErrors(w, { config, mirror: null, batch: [w] })[0], RE, "with no export too");
});

test("with its waiting item in the same batch, or one open on the board, it passes", () => {
  const w = msg(), a = ask();
  assert.deepEqual(questionAskErrors(w, { config, mirror: mirror(), batch: [w, a] }), []);
  assert.deepEqual(questionAskErrors(w, { config, mirror: mirror(), batch: [w, { ...a, op: "update", data: { text: "again" } }] }), [], "an update reopening it");
  assert.deepEqual(questionAskErrors(w, { config, mirror: mirror([{ id: "t-389", kind: "action", text: "q", since: 1 }]), batch: [w] }), []);
});

test("a done item, another thread's item, or one being closed doesn't count", () => {
  const w = msg();
  assert.equal(questionAskErrors(w, { config, mirror: mirror([{ id: "t-389", done: true, since: 1 }]), batch: [w] }).length, 1, "done on the board");
  assert.equal(questionAskErrors(w, { config, mirror: mirror(), batch: [w, ask({ done: true })] }).length, 1, "set done in the batch");
  assert.equal(questionAskErrors(w, { config, mirror: mirror(), batch: [w, { ...ask(), doc_id: "t-1" }] }).length, 1, "another thread's");
  assert.equal(questionAskErrors(w, { config, mirror: mirror(), batch: [w, { ...ask(), op: "delete", data: undefined }] }).length, 1, "a delete");
});

test("only a new question from someone other than the owner: the owner's own, other kinds and updates pass", () => {
  for (const w of [msg({ from: "Sam" }), msg({ kind: "answer" }), msg({ kind: undefined }), { ...msg(), op: "update" }]) assert.deepEqual(questionAskErrors(w, { config, mirror: mirror(), batch: [w] }), [], JSON.stringify(w));
});

test("the gate runs it on every write (checkWrites), with or without an export", () => {
  const w = msg();
  const errs = (batch, m) => checkWrites(batch, { config, who: { role: "Manager", manager: true }, now: 5, state: {}, mirror: m }).errors.filter((e) => /reaches Needs you only as a waiting item/.test(e));
  assert.equal(errs([w], mirror()).length, 1);
  assert.equal(errs([w], null).length, 1);
  assert.equal(errs([w, ask()], mirror()).length, 0);
});
