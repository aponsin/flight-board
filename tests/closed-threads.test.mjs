// A closed ask's thread stays reachable (#C288): the owner lost a whole conversation when its six asks were done. Their
// threads went to "Resolved threads", whose list stops at 50 rows, and a #T link opened only a thread already drawn.
// Now a card's Thread fold also holds its closed asks, each with its full thread, and a #T opens any resolved thread.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, DAY = 864e5;
const board = (st = {}) => { const b = loadNames(["initRow", "enrich", "gates", "rlistHtml", "resolvedHtml", "tRefQuery", "cardAsks"]); Object.assign(b.state, st); return b; };
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}-${thread}`, thread, from, text, at, ...extra });
const card = { id: "trace", name: "Trace the visits", status: "active", level: "Full", size: "S" };
const done = (id, text, extra = {}) => ({ id, kind: "action", text, since: T - DAY, initiative: "trace", done: true, ...extra });

test("a card's Thread fold holds its closed asks, each with its whole thread, newest first", () => {
  const b = board({
    initRaw: [card],
    waiting: [done("zoho", "Check your Sent box"), done("logs", "Open the Workers logs"), done("other", "Unrelated", { initiative: "elsewhere" }),
      done("quiet", "Closed with no thread"), { id: "live", kind: "action", text: "Still open", since: T, initiative: "trace" }],
    messages: [msg("zoho", "Owner", "nothing in my Sent box", T - 3000), msg("zoho", "Manager", "Then it's Safari", T - 2000),
      msg("logs", "Owner", "this what you wanted?", T - 1000), msg("logs", "Manager", "That's it, thank you", T - 500),
      msg("other", "Manager", "elsewhere", T), msg("live", "Owner", "a question", T)],
    threads: [{ id: "zoho", num: 877 }, { id: "logs", num: 878 }],
  });
  const html = b.initRow(b.gates(b.enrich(card)));
  assert.match(html, /<summary>Thread · 2 closed asks<\/summary>/, "no card thread yet: the fold still opens, and says what it holds");
  assert.match(html, /Closed asks on this card/);
  for (const t of ["Check your Sent box", "nothing in my Sent box", "Then it&#39;s Safari|Then it's Safari", "Open the Workers logs", "That&#39;s it, thank you|That's it, thank you"]) assert.match(html, new RegExp(t), t);
  assert.ok(html.indexOf("Open the Workers logs") < html.indexOf("Check your Sent box"), "newest word first");
  assert.match(html, /class="thread" data-thread="zoho"/);
  assert.match(html, /data-tsend="zoho"/, "a reply box: the conversation goes on from the card");
  assert.match(html, /#T877/);
  assert.doesNotMatch(html, /Unrelated|Closed with no thread|Still open/, "another card's ask, an ask with no thread, an open ask (it shows under Needs you)");
  assert.deepEqual([...b.cardAsks("trace", T)].map((w) => w.id), ["logs", "zoho"]);
});

test("Designer: a closed ask on its card reads as the ask it was: its own kind and colour, no 'Reply to:', a reopen hint", () => {
  const b = board({ initRaw: [card], waiting: [done("zoho", "Check your Sent box"), done("ans", "It was Safari", { kind: "answer" }), done("odd", "Odd kind", { kind: "constructor" })],
    messages: [msg("zoho", "Manager", "Safari", T), msg("ans", "Manager", "ok", T - 1), msg("odd", "Manager", "x", T - 2)] });
  const html = b.initRow(b.gates(b.enrich(card)));
  const block = html.slice(html.indexOf('class="i-asks"'));
  assert.match(block, /<span class="kind action">Your click<\/span>/);
  assert.match(block, /<span class="kind answer">Answer<\/span>/);
  assert.match(block, /<span class="kind constructor">constructor<\/span>/, "an inherited name is shown as itself, never a function");
  assert.doesNotMatch(block, /Reply to:|<span class="kind">Thread<\/span>/);
  assert.equal((block.match(/Writing here reopens it\./g) ?? []).length, 3);
  assert.match(b.rlistHtml(T, ""), /Reply to: <b class="t-name">Check your Sent box/, "the Resolved list draws it as before");
  assert.doesNotMatch(b.rlistHtml(T, ""), /Writing here reopens it/);
});

test("the card's own thread and its closed asks, together; no closed asks: the fold as before", () => {
  const b = board({ initRaw: [card], waiting: [done("zoho", "Check your Sent box")], messages: [msg("trace", "Owner", "why?", T), msg("zoho", "Manager", "Safari", T)] });
  assert.match(b.initRow(b.gates(b.enrich(card))), /<summary>Thread \(1\) · 1 closed ask<span class="t-badge open">with the team<\/span><\/summary>/, "the card's own badge stays");
  const bare = board({ initRaw: [card] });
  assert.match(bare.initRow(bare.gates(bare.enrich(card))), /<summary>Start a thread<\/summary>/);
  assert.doesNotMatch(bare.initRow(bare.gates(bare.enrich(card))), /closed ask/);
});

test("the same thread on the card and in the panel keeps unique box ids", () => {
  const b = board({ initRaw: [card], waiting: [done("zoho", "Check your Sent box")], messages: [msg("zoho", "Manager", "Safari", T)] });
  const ids = (h) => [...h.matchAll(/id="(tnote-[^"]+)"/g)].map((m) => m[1]);
  const onCard = ids(b.initRow(b.gates(b.enrich(card)))), inPanel = ids(b.rlistHtml(T, ""));
  assert.ok(onCard.includes("tnote-card-init-zoho") && inPanel.includes("tnote-panel-zoho"));
  assert.ok(!onCard.some((i) => inPanel.includes(i)));
});

test("#T opens a resolved thread even past the 50-row list: the search narrows to exactly that number", () => {
  const waiting = [], messages = [], threads = [];
  for (let n = 1; n <= 80; n++) { waiting.push(done(`a${n}`, `Ask ${n}`)); messages.push(msg(`a${n}`, "Manager", `Answer ${n}`, T - n * 1000)); threads.push({ id: `a${n}`, num: n }); }
  const b = board({ waiting, messages, threads });
  assert.doesNotMatch(b.rlistHtml(T, ""), /data-thread="a77"/, "the week's list stops at 50");
  const q = b.tRefQuery("a77", T);
  assert.equal(q, "#T77");
  const hit = b.rlistHtml(T, q);
  assert.match(hit, /data-thread="a77"/);
  assert.equal((hit.match(/<details class="w-item"/g) ?? []).length, 1, "exactly #T77");
  assert.doesNotMatch(b.rlistHtml(T, "#T7"), /data-thread="a7[0-9]"/, "#T7 is not #T70–#T79");
  assert.match(b.rlistHtml(T, "#t7"), /data-thread="a7"/, "the search box: any case");
  assert.equal(b.tRefQuery("nope", T), null, "not a resolved thread: nothing to search");
  // Checker: a numbered thread still open or answered isn't in the resolved list, so no search would find it.
  b.state.messages.push(msg("t-open", "Owner", "still a question", T), msg("t-ans", "Manager", "an answer to read", T));
  b.state.threads.push({ id: "t-open", num: 901 }, { id: "t-ans", num: 902 });
  assert.equal(b.tRefQuery("t-open", T), null, "open: waits on Manager, drawn in its own section");
  assert.equal(b.tRefQuery("t-ans", T), null, "answered: drawn under Needs you");
});
