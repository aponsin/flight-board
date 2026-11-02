// An answer isn't resolved before the owner has read it (#C585: on 11-01 an answer was marked resolved and hidden before
// they saw it, and only a memory rule stood in the way). The gate refuses resolved: true on the lead's answer to the
// owner's newest message, and a resolve of a lead message older than the owner's newest word.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites } from "../gate/rules.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", owner: "Owner" });
const NOW = 1_800_000_123_457;
const lead = { role: "Manager", manager: true }, ops = { role: "Ops", manager: false };
const M = (id, thread, from, at) => ({ id, thread, from, text: "x", at });
const seenOf = (...messages) => ({ docs: { messages, waiting: [] }, at: NOW - 6e6, atBy: {} });
const call = (w, who, seen) => checkWrites([w], { config, who, now: NOW, state: {}, mirror: null, seen }).errors.join(" | ");
const set = (data, id = "m-new") => ({ op: "set", collection: "messages", doc_id: id, data: { thread: "t-a", from: "Manager", text: "the answer", at: NOW, ...data } });
const resolve = (id) => ({ op: "update", collection: "messages", doc_id: id, data: { resolved: true } });

test("the lead's answer to the owner's newest message is never set resolved", () => {
  const unanswered = seenOf(M("m1", "t-a", "Owner", NOW - 6e5));
  assert.match(call(set({ resolved: true }), lead, unanswered), /isn't set resolved: they haven't read it yet/);
  assert.doesNotMatch(call(set({}), lead, unanswered), /resolved/, "the same answer unresolved is fine");
  assert.doesNotMatch(call(set({ resolved: true, thread: "t-b" }), lead, unanswered), /resolved: they haven't/, "another thread");
  const answered = seenOf(M("m1", "t-a", "Owner", NOW - 9e5), M("m2", "t-a", "Manager", NOW - 6e5));
  assert.doesNotMatch(call(set({ resolved: true }), lead, answered), /haven't read it/, "a thread already answered: a closing note may resolve");
  assert.doesNotMatch(call(set({ resolved: true }), lead, seenOf()), /haven't read it/, "no owner message in the thread");
});

test("the owner's message set earlier in the same call is on the board; a resolved answer after it is refused", () => {
  const batch = [{ op: "set", collection: "messages", doc_id: "m-o", data: { thread: "t-a", from: "Owner", text: "q", at: NOW - 1000 } }, set({ resolved: true }, "m-a")];
  const errs = checkWrites(batch, { config, who: lead, now: NOW, state: {}, mirror: null, seen: seenOf() }).errors.join(" | ");
  assert.match(errs, /messages\/m-a: .*haven't read it/);
});

test("resolving a lead message older than the owner's newest word is refused; one the owner has replied after is allowed", () => {
  const owner = seenOf(M("m-lead", "t-a", "Manager", NOW - 9e5), M("m-owner", "t-a", "Owner", NOW - 6e5));
  assert.match(call(resolve("m-lead"), lead, owner), /still unanswered: answer it before marking the thread resolved/);
  const after = seenOf(M("m-owner", "t-a", "Owner", NOW - 9e5), M("m-lead", "t-a", "Manager", NOW - 6e5));
  assert.doesNotMatch(call(resolve("m-lead"), lead, after), /unanswered/, "the owner's word is older than the answer");
  assert.match(call(resolve("m-lead"), ops, owner), /a message is never changed/, "only the lead, as before");
});
