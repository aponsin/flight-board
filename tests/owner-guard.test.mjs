// The owner's words are the page's alone (#C337, Security after #C334: the owner's text reaches the lead with a hook's
// weight). No session writes a message from the owner, nor an ask's response; the lead may only clear a response, to
// reopen an ask that isn't done (Manager: the owner's pick that was really a question).
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors, checkWrites } from "../gate/rules.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", owner: "Owner" });
const NOW = 1_800_000_123_457;
const lead = { role: "Manager", manager: true }, ops = { role: "Ops", manager: false };
const errs = (w, who) => writeErrors(w, { config, who, now: NOW }).join(" | ");
const msg = (from, op = "set") => ({ op, collection: "messages", doc_id: "m1", data: { thread: "t-a", from, text: "hi", at: NOW } });

test("no session writes a message from the owner: set or update, the lead included", () => {
  assert.match(errs(msg("Owner"), ops), /from: "Owner" is the owner's: only the board's page writes it/);
  assert.match(errs(msg("Owner"), lead), /only the board's page writes it/);
  assert.match(errs({ op: "update", collection: "messages", doc_id: "m1", data: { from: "Owner" } }, lead), /only the board's page writes it/);
  assert.doesNotMatch(errs(msg("Manager"), lead), /owner's/);
  assert.doesNotMatch(errs(msg("Ops"), ops), /owner's/);
});

test("no session writes an ask's response; the lead may clear one on an ask that isn't done", () => {
  const ask = (data, op = "update") => ({ op, collection: "waiting", doc_id: "w-a", data });
  assert.match(errs(ask({ response: { status: "chose", choice: "A" } }), lead), /response is the owner's answer: only the board's page writes it/);
  assert.match(errs(ask({ response: { status: "ok" } }), ops), /only the board's page writes it/);
  assert.match(errs(ask({ kind: "decision", text: "x", since: NOW, response: { status: "ack" } }, "set"), lead), /only the board's page writes it/);
  assert.match(errs(ask({ response: { __delete__: true } }), ops), /only Manager clears a response/);
  assert.match(errs(ask({ response: { __delete__: true }, done: true }), lead), /reopens the ask: not with done/);
  assert.doesNotMatch(errs(ask({ response: { __delete__: true } }), lead), /response/, "the lead reopens an ask");
  assert.doesNotMatch(errs(ask({ done: true }), lead), /response/, "closing an ask is untouched");
});

test("a batch with one such write is refused whole", () => {
  const writes = [{ op: "set", collection: "messages", doc_id: "m2", data: { thread: "t-a", from: "Manager", text: "ok", at: NOW } }, msg("Owner")];
  const out = checkWrites(writes, { config, who: lead, now: NOW, state: {}, mirror: null });
  assert.ok(out.errors.some((e) => /only the board's page writes it/.test(e)));
});
