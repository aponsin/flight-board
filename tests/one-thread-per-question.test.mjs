// #C597, one thread per question: an answer can turn into a decision in place (PR #301 made two items: an answer and a
// separate decision). The gate lets the lead do it, even after the owner replied, in one update that clears the response;
// options on a non-decision with no kind named are refused (they would draw no buttons).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites } from "../gate/rules.mjs";
import { loadNames } from "./harness.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const config = fullConfig({ artifactUrl: URL_ });
const now = Date.now() - 1234;
const lead = { role: "Manager", manager: true }, builder = { role: "Builder" };
const two = [{ key: "A", label: "one" }, { key: "B", label: "two" }];
const base = { id: "ans-1", kind: "answer", text: "Here is the answer", question: "What about PR 301?", since: now - 5000 };
const mirrorOf = (doc) => ({ docs: { waiting: [doc], messages: [{ id: "m1", thread: doc.id, from: config.owner, text: "q", at: now - 9000 }], initiatives: [], steps: [] }, at: now - 100, atBy: {} });
const open = mirrorOf({ ...base, done: false });
const acked = mirrorOf({ ...base, done: true, doneAt: now - 2000, response: { status: "ack", at: now - 2000 }, respondedAt: now - 2000 });
const up = (data) => [{ op: "update", collection: "waiting", doc_id: "ans-1", data }];
const errs = (mirror, writes, who = lead) => checkWrites(writes, { config, who, now, state: {}, mirror }).errors;
const reopen = { response: { __delete__: true }, respondedAt: { __delete__: true }, doneAt: { __delete__: true } };

test("an open answer turns into a decision in place: kind and options in one update", () => {
  assert.deepEqual(errs(open, up({ kind: "decision", options: two })), []);
  assert.deepEqual(errs(open, up({ kind: "decision", options: two, text: "Pick one" })), []);
});

test("options on an answer with no kind named are refused: they would draw no buttons", () => {
  const e = errs(open, up({ options: two }));
  assert.equal(e.length, 1);
  assert.match(e[0], /options show as buttons only on kind "decision".*update \{kind: "decision", options\}/);
  assert.deepEqual(errs(mirrorOf({ ...base, kind: "decision", options: two, done: false }), up({ options: two.slice().reverse() })), [], "a decision keeps taking options");
});

test("an answer the owner already replied to turns into a decision when the same update clears their response", () => {
  assert.deepEqual(errs(acked, up({ kind: "decision", options: two, done: false, ...reopen })), []);
  assert.deepEqual(errs(acked, up({ kind: "decision", options: two, text: "Pick one", done: false, ...reopen })), []);
});

test("without the response cleared the wording stays frozen, and the refusal names the way", () => {
  const e = errs(acked, up({ kind: "decision", options: two, done: false }));
  assert.equal(e.length, 1);
  assert.match(e[0], /wording is frozen; open a new ask for another question \(or, to turn an answer into a decision in place, update \{kind: "decision", options, response: \{__delete__: true\}\}\)/);
  assert.equal(errs(acked, up({ text: "other words" })).length, 1, "new text alone is still frozen");
});

test("the in-place turn needs two options, changes only kind, options and text, and is the lead's", () => {
  assert.match(errs(acked, up({ kind: "decision", options: [two[0]], done: false, ...reopen }))[0], /at least two options/);
  assert.match(errs(acked, up({ kind: "decision", options: two, done: false, ...reopen, initiative: "other-card" }))[0], /changes only kind, options, text and the response it clears \(not initiative\)/);
  assert.equal(errs(acked, up({ kind: "decision", options: two, done: false, ...reopen }), builder).length > 0, true, "another role's update is refused as before");
});

test("only an answer turns this way: an answered decision's wording stays frozen", () => {
  const decided = mirrorOf({ ...base, kind: "decision", options: two, done: true, response: { status: "chose", choice: "A", at: now - 2000 }, respondedAt: now - 2000 });
  assert.equal(errs(decided, up({ kind: "decision", options: [...two, { key: "C", label: "three" }], response: { __delete__: true } })).length, 1);
});

test("the page draws the converted item as a decision with a button per option, in its thread's reply box", () => {
  const b = loadNames(["replyBox"]);
  const html = b.replyBox({ id: "ans-1", kind: "decision", text: "Pick one", question: "What about PR 301?", options: two, since: Date.now() - 5000 });
  assert.match(html, /data-act="chose" data-choice="A" data-id="ans-1"><b>A<\/b> one<\/button>/, "the first option is a button");
  assert.match(html, /data-act="chose" data-choice="B" data-id="ans-1"><b>B<\/b> two<\/button>/, "and the second");
  assert.doesNotMatch(html, /data-act="ack"/, "no Ack: it is a pick now");
});
