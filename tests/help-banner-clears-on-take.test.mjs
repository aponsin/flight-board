// #C1023 (help-banner-clears-on-take): on the store page, an answer the owner sent keeps its red "You asked for help ... Sending to Manager…" line
// only until Manager has taken it (his read sets taken, compat-view) and has not written in the thread since. The owner, 11-12: a help answer with two pictures
// still showed the line after Manager had read both and replied.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const STORE = { documentElement: { getAttribute: (n) => (n === "data-host" ? "store" : null) } };
const T = 1_800_000_000_000;
const msg = (thread, from, at, text = "x") => ({ id: `m${thread}${from}${at}`, thread, from, text, at });
const load = (messages, globals = STORE) => {
  const b = loadNames(["replyBox", "threadOf"], globals);
  Object.assign(b.state, { waiting: [], initRaw: [], initiatives: [], todo: [], ideas: [], threads: [], messages });
  return b;
};
const help = (over = {}, files = undefined) => ({ id: "t-1", kind: "decision", text: "x", response: { status: "help", at: T, note: "see the pictures", ...(files ? { files } : {}), ...over } });

test("an untaken help answer on the store says Sending to Manager…; a taken one says Manager has it", () => {
  const b = load([msg("t-1", "Owner", T)]);
  const untaken = b.replyBox(help({ taken: false }));
  assert.match(untaken, /You asked for help/);
  assert.match(untaken, /Sending to Manager…/);
  assert.doesNotMatch(untaken, /Manager has it/);
  const taken = b.replyBox(help({ taken: true }));
  assert.match(taken, /You asked for help/);
  assert.match(taken, /Manager has it\./);
  assert.doesNotMatch(taken, /Sending to Manager/);
  assert.match(b.replyBox(help({})), /Manager has it\./, "an older Worker sends no taken key: never Sending");
});

test("a taken answer with a later Manager message shows nothing; an earlier one, someone else's, or another thread's does not", () => {
  const b = load([msg("t-1", "Owner", T), msg("t-1", "Manager", T + 5 * 60e3, "I read both and replied")]);
  assert.equal(b.replyBox(help({ taken: true })), "", "Manager wrote after the answer");
  assert.equal(b.replyBox(help({ taken: false })), "", "he wrote in the thread: he has seen it, whatever the flag says");
  const before = load([msg("t-1", "Manager", T - 60e3), msg("t-1", "Owner", T)]);
  assert.match(before.replyBox(help({ taken: true })), /Manager has it/, "Manager's earlier word is not a reply to it");
  const other = load([msg("t-1", "Owner", T), msg("t-1", "Checker", T + 60e3), msg("t-2", "Manager", T + 60e3)]);
  assert.match(other.replyBox(help({ taken: true })), /Manager has it/, "another role's word, or Manager's in another thread, clears nothing");
  const same = load([msg("t-1", "Manager", T)]);
  assert.match(same.replyBox(help({ taken: true })), /Manager has it/, "a message at the same moment is not after it");
});

test("pictures change none of this", () => {
  const files = [{ id: "f1", name: "a.png" }, { id: "f2", name: "b.png" }];
  const open = load([msg("t-1", "Owner", T)]);
  assert.match(open.replyBox(help({ taken: false }, files)), /Sending to Manager…/);
  assert.match(open.replyBox(help({ taken: true }, files)), /Manager has it\./);
  const replied = load([msg("t-1", "Owner", T), msg("t-1", "Manager", T + 1)]);
  assert.equal(replied.replyBox(help({ taken: true }, files)), "");
});

test("every status clears the same way, a bare Ack keeps its short line, and a note on an Ack counts as a sent answer", () => {
  const replied = load([msg("t-1", "Owner", T), msg("t-1", "Manager", T + 1)]);
  for (const status of ["ok", "change", "done", "chose", "help"]) assert.equal(replied.replyBox(help({ status, taken: true, choice: "A" })), "", status);
  assert.match(replied.replyBox(help({ status: "ack", note: undefined })), /You acknowledged this/, "a bare Ack is not a sent answer: its line stays, with no 'Sending'");
  assert.equal(replied.replyBox(help({ status: "ack", note: "thanks" })), "", "an Ack with a note went to Manager");
  const open = load([msg("t-1", "Owner", T)]);
  assert.doesNotMatch(open.replyBox(help({ status: "ack", note: undefined, taken: false })), /Sending to Manager/);
});

test("off the store nothing changes: the artifact page still reads its own ping state", () => {
  const b = load([msg("t-1", "Owner", T), msg("t-1", "Manager", T + 1)], {});
  const w = help({ taken: true });
  assert.match(b.replyBox(w), /Sending to Manager…/, "no ping state yet");
  assert.match(b.replyBox({ ...w, ping: "sent" }), /Sent to Manager\./);
});
