// One comment thread per board item (#C509: from 2026-10-30 01:50Z every Ping and new thread said "Not sent (refused:
// upstream_error)": the page opened a new comment thread for every send, and the artifact held 1,000, its limit). The
// first send about an item opens a thread and keeps its id; later ones reply into it. A refused new thread says the
// threads are full, at once; the page warns when its count nears the limit.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = 1_800_000_000_000;
const TID = "2936bf3a-fac0-4eb9-a33d-334aa76ac30d";

function board({ fail = null } = {}) {
  const writes = [], sends = [];
  let refuse = fail;
  const db = { doc: (path) => ({ set: async (data) => writes.push({ path, data }), update: async (data) => writes.push({ path, data }) }) };
  const comments = {
    canSendToClaude: async () => "available",
    sendToClaude: async (target) => {
      sends.push(target);
      const code = typeof refuse === "function" ? refuse(target) : refuse;
      if (code) { const e = new Error("no"); e.code = code; throw e; }
      return { threadId: target.threadId ?? target.anchor?.id ?? TID, commentId: "c1" };
    },
  };
  const b = loadNames(["sendPing", "pingThreadOf", "threadsCount", "renderThreadsFull", "set:(d,c)=>{dbRef=d;commentsRef=c}"]);
  b.set(db, comments);
  return { b, writes, sends, refuse: (f) => { refuse = f; } };
}

test("the first send about an item opens a thread and keeps its id; the next replies into it", async () => {
  const { b, writes, sends } = board();
  assert.equal(await b.sendPing({ a: 1 }, "Board reply [t-1]: …", "t-1"), true);
  assert.equal(JSON.stringify(sends[0]), JSON.stringify({ anchor: { a: 1 }, text: "Board reply [t-1]: …" }));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "pingThreads/t-1");
  assert.equal(writes[0].data.threadId, TID);
  b.state.pingThreads = [{ id: "t-1", threadId: TID, at: T }];
  assert.equal(await b.sendPing({ a: 1 }, "Board ping [t-1]", "t-1"), true);
  assert.equal(JSON.stringify(sends[1]), JSON.stringify({ threadId: TID, text: "Board ping [t-1]" }), "a reply, no new thread");
  assert.equal(writes.length, 1, "nothing new to keep");
  assert.equal(await b.sendPing(null, "Board ping [t-1]", "t-1"), true, "a reply needs no anchor");
});

test("a thread deleted in the panel opens anew; an odd id or ref never makes a reply or a document", async () => {
  const { b, writes, sends, refuse } = board();
  b.state.pingThreads = [{ id: "t-1", threadId: TID, at: T }, { id: "t-2", threadId: "<bad>", at: T }];
  refuse((t) => (t.threadId ? "not_found" : null));
  assert.equal(await b.sendPing({ a: 1 }, "x", "t-1"), true);
  assert.equal(sends.length, 2);
  assert.ok(sends[1].anchor, "opened anew");
  assert.equal(writes[0].path, "pingThreads/t-1");
  assert.equal(b.pingThreadOf("t-2"), null);
  assert.equal(b.pingThreadOf("../x"), null);
  await b.sendPing({ a: 1 }, "x", "../meta/x");
  assert.equal(writes.length, 1, "a bad ref keeps nothing");
});

test("a new thread refused upstream_error says the threads are full, at once; the next one that opens clears it", async () => {
  const { b, refuse } = board({ fail: "upstream_error" });
  assert.equal(await b.sendPing({ a: 1 }, "x", "t-9"), false);
  b.renderThreadsFull();
  assert.equal(b.els.threadsfull.hidden, false);
  assert.match(b.els.threadsfull.textContent, /^The board's comment threads are full: Send to Claude can't open a new one/);
  refuse(null);
  assert.equal(await b.sendPing({ a: 1 }, "x", "t-10"), true);
  assert.equal(b.els.threadsfull.hidden, true);
});

test("a kept thread at its reply limit (upstream_error) gets one new thread, kept in its place (Checker)", async () => {
  const NEW = "11111111-2222-3333-4444-555555555555";
  const { b, writes, sends } = board({ fail: (t) => (t.threadId ? "upstream_error" : null) });
  b.state.pingThreads = [{ id: "ctx-Builder", threadId: TID, at: T }];
  assert.equal(await b.sendPing({ a: 1, id: NEW }, "x", "ctx-Builder"), true);
  assert.equal(sends.length, 2, "the reply, then one new thread");
  assert.ok(sends[1].anchor);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "pingThreads/ctx-Builder");
  assert.equal(writes[0].data.threadId, NEW, "the new thread's id replaces the old one");
  b.renderThreadsFull();
  assert.equal(b.els.threadsfull.hidden, true, "not full: the new thread opened");
  const full = board({ fail: "upstream_error" });
  full.b.state.pingThreads = [{ id: "t-1", threadId: TID, at: T }];
  assert.equal(await full.b.sendPing({ a: 1 }, "x", "t-1"), false);
  assert.equal(full.sends.length, 2, "one retry only");
  full.b.renderThreadsFull();
  assert.equal(full.b.els.threadsfull.hidden, false, "the new one refused too: said");
  const r = board({ fail: "rate_limited" });
  await r.b.sendPing({ a: 1 }, "x", "t-2");
  r.b.renderThreadsFull();
  assert.equal(r.b.els.threadsfull.hidden, true);
});

test("a shell that stops answering (canSendToClaude refused upstream_error) is not the thread limit", async () => {
  const { b } = board();
  b.set({ doc: () => ({ set: async () => {} }) }, { canSendToClaude: async () => { const e = new Error("no"); e.code = "upstream_error"; throw e; }, sendToClaude: async () => ({}) });
  assert.equal(await b.sendPing({ a: 1 }, "x", "t-1"), false);
  b.renderThreadsFull();
  assert.equal(b.els.threadsfull.hidden, true);
});

test("nearly full: Manager's count after a cleanup plus the threads opened since; 900 or more warns", () => {
  const { b } = board();
  b.state.meta = [{ id: "commentThreads", count: 890, at: T }];
  b.state.pingThreads = Array.from({ length: 10 }, (_, k) => ({ id: `t-${k}`, threadId: TID, at: T + k + 1 })).concat([{ id: "old", threadId: TID, at: T - 1 }]);
  assert.equal(b.threadsCount(), 900);
  b.renderThreadsFull();
  assert.equal(b.els.threadsfull.hidden, false);
  assert.match(b.els.threadsfull.textContent, /nearly full \(900 of about 1,000\)/);
  b.state.pingThreads.pop(); b.state.pingThreads.pop();
  b.renderThreadsFull();
  assert.equal(b.els.threadsfull.hidden, true, "899: no warning");
  b.state.meta = [];
  assert.equal(b.threadsCount(), null, "no count from Manager: no guess");
});

test("every send names its item, so each item keeps one thread", () => {
  assert.match(page, /sendPing\(anchor,threadPingText\(id,now\),id\)/);
  assert.match(page, /:text\|\|"\(files\)",kind\),id\)/);
  assert.match(page, /ok=await sendPing\(anchor,`Board idea \[\$\{t\.id\}\]/);
  assert.match(page, /sendPing\(anchor,ctxPingText\(n\),`ctx-\$\{n\}`\)/);
  assert.match(page, /return sendPing\(anchor,pingText\(.*\),id\)\}/);
  assert.equal((page.match(/commentsRef\.sendToClaude\(/g) || []).length, 2, "only sendPing calls the app");
  assert.match(page, /renderShipLine\(\);renderThreadsFull\(\);/);
});
