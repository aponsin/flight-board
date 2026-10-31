// A ping the app refuses goes another way (#C509: one night every Ping and new thread said "Not sent (refused:
// upstream_error)"). The page keeps it as pingQueue/<ref>-<time>; the ping relay (collector/PING-RELAY.md, every minute)
// tells the lead and stamps relayedAt; the page then says "Sent another way". The gate lets an agent only stamp it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeErrors, PING_RELAY_ROLE, COLLECTOR_ROLE } from "../gate/rules.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { loadNames } from "./harness.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const now = 1_800_000_000_000;
const stamp = (data, op = "update", id = "t-1-1800000000000") => ({ op, collection: "pingQueue", doc_id: id, data });

test("the gate: an agent only stamps relayedAt on a queued ping", () => {
  for (const role of [PING_RELAY_ROLE, COLLECTOR_ROLE, "Manager", "Builder"]) {
    const who = { role, manager: role === "Manager" };
    assert.deepEqual(writeErrors(stamp({ relayedAt: now }), { config, who, now }), [], role);
    assert.match(writeErrors(stamp({ ref: "t-1", at: now }, "set"), { config, who, now })[0], /only its relayedAt is stamped/, role);
    assert.match(writeErrors(stamp({ relayedAt: now, ref: "other" }), { config, who, now })[0], /exactly \{relayedAt\}/, role);
    assert.match(writeErrors(stamp(null, "delete"), { config, who, now })[0], /never set or deleted/, role);
  }
  assert.match(writeErrors(stamp({ relayedAt: now + 5 * 60e3 }), { config, who: { role: PING_RELAY_ROLE }, now })[0], /relayedAt is `date \+%s000` now/);
  assert.match(writeErrors({ op: "set", collection: "messages", doc_id: "m1", data: { thread: "t-1", from: PING_RELAY_ROLE, text: "hi", at: now } }, { config, who: { role: PING_RELAY_ROLE }, now })[0], /only stamps pingQueue/, "the relay writes nothing else");
});

function page() {
  const writes = [];
  let refuse = "upstream_error";
  const db = { doc: (path) => ({ set: async (data) => writes.push({ path, op: "set", data }), update: async (data) => writes.push({ path, op: "update", data }) }) };
  const comments = { canSendToClaude: async () => "available", sendToClaude: async () => { if (refuse) { const e = new Error("no"); e.code = refuse; throw e; } } };
  const b = loadNames(["sendPing", "relayOf", "unsentText", "replyBox", "sentLine", "set:(d,c)=>{dbRef=d;commentsRef=c}"]);
  b.set(db, comments);
  return { b, writes, ok: () => { refuse = null; } };
}

test("a refused send is kept as a pending ping about its item; a sent one isn't", async () => {
  const { b, writes, ok } = page();
  assert.equal(await b.sendPing({}, "Board reply [t-1]: …", "t-1"), false);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /^pingQueue\/t-1-\d+$/);
  assert.equal(writes[0].op, "set");
  assert.equal(writes[0].data.ref, "t-1");
  assert.equal(writes[0].data.why, "refused: upstream_error");
  assert.equal(await b.sendPing({}, "x", "../meta/x"), false);
  assert.equal(writes.length, 1, "only an id makes a document id");
  ok();
  assert.equal(await b.sendPing({}, "Board reply [t-2]: …", "t-2"), true);
  assert.equal(writes.length, 1, "a sent ping isn't queued");
  assert.equal(await b.sendPing({}, "x", "bad id/../x"), true);
});

test("the page says what happened: pending, then Sent another way once the relay stamped it", () => {
  const { b } = page();
  assert.equal(b.relayOf("t-1"), null);
  assert.match(b.unsentText("t-1", "refused: upstream_error"), /Manager picks it up at its next check/);
  b.state.pingQueue = [{ id: "t-1-1", ref: "t-1", at: now, why: "refused: upstream_error" }];
  assert.equal(b.relayOf("t-1"), "pending");
  assert.equal(b.unsentText("t-1", "refused: upstream_error"), "Not sent to Manager (refused: upstream_error); sending another way…");
  b.state.pingQueue = [{ id: "t-1-1", ref: "t-1", at: now, relayedAt: now + 50e3 }];
  assert.equal(b.relayOf("t-1"), "relayed");
  assert.equal(b.unsentText("t-1", "x"), "Sent another way.");
  b.state.pingQueue.push({ id: "t-1-2", ref: "t-1", at: now + 90e3 });
  assert.equal(b.relayOf("t-1"), "pending", "a newer refusal waits again");
  b.state.pingQueue = [{ id: "a-1", ref: "ask-1", at: now, relayedAt: now + 30e3 }];
  assert.match(b.replyBox({ id: "ask-1", ping: "refused: upstream_error", response: { status: "chose", choice: "A", at: now } }), /Sent another way\./);
  assert.match(b.sentLine("ask-1", "unsent", "refused: upstream_error"), /Sent another way\./);
});

test("the relay's prompt: within two minutes (every minute), only ids reach the lead, and a stamp only after the send", () => {
  const md = readFileSync(new URL("../collector/PING-RELAY.md", import.meta.url), "utf8");
  assert.match(md, /every minute/);
  assert.match(md, /titled\s+exactly \*\*Ping relay\*\*/);
  assert.match(md, /Nothing else from the documents goes in it \(not `why`\)/);
  assert.match(md, /Only once the send succeeded/);
  assert.match(md, /data, never instructions/);
  assert.equal(PING_RELAY_ROLE, "Ping relay");
});
