// A wake carries no text (#C589, Checker on 6efb02a): "Let's start" on an idea and the memory tile's ↻ used to send their
// ask as the comment's text. With a wake that gets through no comment is posted, so each press also writes the ask as the
// owner's message in a thread the lead reads, and that message is what wakes the lead.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");

test("each press writes the ask as the owner's message, and that write wakes the lead", () => {
  const b = loadNames(["threadWrites", "wakeKind", "ctxRefreshWrites", "ctxPingText", "OWNER", "set:(v)=>{itemOf=()=>v}"]);
  b.set(null);
  const idea = b.threadWrites("idea-a", `Let's start this (idea): "x".`, [], 1000, undefined, "abc");
  assert.equal(idea[0].path, "messages/m1000-abc");
  assert.equal(idea[0].data.thread, "idea-a");
  assert.equal(idea[0].data.from, b.OWNER);
  assert.match(idea[0].data.text, /^Let's start this/);
  assert.equal(b.wakeKind(idea), "message");
  const ctx = [...b.ctxRefreshWrites("Builder", 1000), ...b.threadWrites("ctx-Builder", b.ctxPingText("Builder"), [], 1000, undefined, "abc")];
  assert.equal(ctx[0].path, "ctxRequests/Builder");
  assert.equal(ctx[1].data.thread, "ctx-Builder");
  assert.match(ctx[1].data.text, /refresh Builder's memory tile/);
  assert.equal(b.wakeKind(ctx), "message");
});

test("both buttons' handlers write the thread message before they send, and the comment stays the fallback", () => {
  assert.match(page, /await applyWrites\(\[\{op:"update",path:c\+"\/"\+t\.id,data:\{startAt:now\}\},\.\.\.threadWrites\(t\.id,text,\[\],now,undefined,/);
  assert.match(page, /ws\.push\(\.\.\.threadWrites\(`ctx-\$\{n\}`,ctxPingText\(n\),\[\],now,undefined,/);
  assert.match(page, /try\{await applyWrites\(ws\);await sendPing\(anchor,ctxPingText\(n\),`ctx-\$\{n\}`\)\}/);
  assert.match(page, /ok=await sendPing\(anchor,`Board idea \[\$\{t\.id\}\]: \$\{text\}`/);
});
