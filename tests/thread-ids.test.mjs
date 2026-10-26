// Thread numbers and names (#T27): the lead's allocation, the gate's rules for it, and the page's links and pings.
import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../scripts/thread-ids.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites } from "../gate/rules.mjs";
import { writesOf, writeState } from "../gate/gate.mjs";
import { afterWrite, after } from "../gate/after.mjs";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNames } from "./harness.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const now = Date.now() - 1234;
const lead = { role: "Manager", manager: true };
const errs = (writes, who = lead, state = {}) => checkWrites(writes, { config, who, now, state }).errors;
const msg = (thread, at) => ({ thread, at, from: "Sam", text: "x" });
const num = (id, n, op = "set") => ({ op, collection: "threads", doc_id: id, data: { num: n } });
const seq = (next, op = "update", if_version = 7) => ({ op, collection: "meta", doc_id: "threadSeq", data: { next }, ...(if_version ? { if_version } : {}) });

test("allocation: numbers in the order threads opened (each thread's first message), kept numbers kept, the counter last", () => {
  const messages = [msg("b", 30), msg("a", 20), msg("a", 10), msg("c", 25), msg("b", 5), { thread: "", at: 1 }, { thread: "x" }];
  const { batches, first, next } = allocate({ threads: [{ id: "c", num: 4 }, { id: "a", title: "Named" }], messages, seq: { next: 5 } });
  assert.equal(first, 5);
  assert.equal(next, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(batches)), [
    [{ op: "update", collection: "threads", doc_id: "c", data: { title: "x" } }],
    [{ op: "set", collection: "threads", doc_id: "b", data: { num: 5, title: "x" } },
      { op: "update", collection: "threads", doc_id: "a", data: { num: 6 } },
      { op: "update", collection: "meta", doc_id: "threadSeq", data: { next: 7 } }]],
  "c numbered with no title gets its first message's (number kept); b opened at 5, a at 10; a keeps its own title");
  assert.equal(allocate({ threads: [{ id: "b", num: 9 }], messages: [msg("a", 1)], seq: { next: 3 } }).first, 10, "never below a number in use");
  assert.equal(allocate({ messages: [msg("a", 1)] }).batches[0].at(-1).op, "set", "the first counter is created");
  assert.deepEqual(allocate({ threads: [{ id: "a", num: 1, title: "A" }], messages: [msg("a", 1)], seq: { next: 2 } }).batches, [], "nothing to number or name");
});

test("allocation: a big backfill comes in batches of at most 50 writes, each moving the counter; the gate takes each", () => {
  const messages = Array.from({ length: 120 }, (_, k) => msg(`t-${String(k).padStart(3, "0")}`, 1000 + k));
  const { batches, next } = allocate({ messages });
  assert.equal(batches.length, 3);
  assert.ok(batches.every((b) => b.length <= 50));
  assert.equal(next, 121);
  assert.deepEqual(batches.map((b) => b.at(-1).op), ["set", "update", "update"]);
  let state = {};
  batches.forEach((b, k) => {
    const sent = b.map((w) => (w.collection === "meta" && k > 0 ? { ...w, if_version: k } : w));
    const out = checkWrites(sent, { config, who: lead, now, state });
    assert.deepEqual(out.errors, [], `batch ${k + 1}`);
    state = afterWrite(out.state, sent);
  });
  assert.equal(state.threadSeq, 121, "the gate remembers the counter the board applied");
  assert.equal(batches[0][0].doc_id, "t-000");
  assert.equal(batches[2].at(-2).data.num, 120);
});

test("gate: only the lead numbers or names threads; a number moves the counter in the same batch, no gap, no repeat", () => {
  const builder = { role: "Builder", manager: false };
  assert.match(errs([num("a", 1), seq(2)], builder).join(), /only Manager numbers and names threads/);
  assert.match(errs([{ op: "update", collection: "threads", doc_id: "a", data: { title: "x" } }], builder).join(), /only Manager/);
  assert.match(errs([seq(5)], builder).join(), /only Manager/);
  assert.deepEqual(errs([num("a", 1), num("b", 2), seq(3, "set", 0)]), [], "the set that creates the counter goes unpinned");
  assert.match(errs([num("a", 1)]).join(), /moves meta\/threadSeq in the same batch/);
  assert.match(errs([num("a", 1), num("b", 3), seq(4)]).join(), /no gap/);
  assert.match(errs([num("a", 2), num("b", 2), seq(3)]).join(), /can't share a number/);
  assert.match(errs([num("a", 0), seq(1)]).join(), /num: a whole number from 1/);
  assert.match(errs([{ op: "delete", collection: "threads", doc_id: "a" }]).join(), /kept for good/);
  assert.match(errs([{ op: "update", collection: "threads", doc_id: "a", data: { title: "  " } }]).join(), /title: 1 to 120/);
  assert.deepEqual(errs([{ op: "update", collection: "threads", doc_id: "a", data: { title: "Collector setup" } }]), [], "a name alone moves no counter");
});

test("gate (Checker's probe): the counter is pinned once it exists and never goes back; numbers below it are refused", () => {
  const at40 = { threadSeq: 40 };
  assert.match(errs([num("t-x", 1), seq(2, "update", 0)], lead, at40).join(), /pin it with if_version/, "unpinned");
  assert.match(errs([seq(2, "update", 0)], lead, at40).join(), /pin it with if_version/, "the counter alone, unpinned");
  assert.match(errs([seq(2, "set", 0)], lead, at40).join(), /pin it with if_version/, "a set over an existing counter");
  assert.match(errs([num("t-x", 1), seq(2)], lead, at40).join(), /never goes back/, "pinned, but back to #T1");
  assert.match(errs([seq(39)], lead, at40).join(), /never goes back/);
  assert.match(errs([num("t-a", 38), num("t-b", 39), num("t-c", 40), seq(41)], lead, at40).join(), /#T38 was handed out already/, "the counter moves up, but the numbers start below it");
  assert.deepEqual(errs([num("t-x", 40), seq(41)], lead, at40), [], "the next number up");
  const out = checkWrites([num("t-x", 40), seq(41)], { config, who: lead, now, state: at40 });
  assert.equal(out.state.threadSeq, 40, "letting a batch through moves nothing: only the board applying it does");
  assert.equal(afterWrite(out.state, [num("t-x", 40), seq(41)]).threadSeq, 41);
  assert.equal(afterWrite(at40, [{ op: "update", collection: "threads", doc_id: "a", data: { title: "x" } }]), at40, "nothing to learn from a rename");
});

test("gate (Checker's second probe): a batch the board refused can be sent again; once applied, its numbers can't", () => {
  const batch = [num("t-a", 40), num("t-b", 41), num("t-c", 42), seq(43)];
  const first = checkWrites(batch, { config, who: lead, now, state: { threadSeq: 40 } });
  assert.deepEqual(first.errors, []);
  // The board refuses it (a stale pin, a network error): no PostToolUse, so the gate's memory stays at 40.
  const rerun = checkWrites(batch, { config, who: lead, now, state: first.state });
  assert.deepEqual(rerun.errors, [], "the rerun of the same numbers passes");
  const applied = afterWrite(rerun.state, batch);
  assert.match(checkWrites(batch, { config, who: lead, now, state: applied }).errors.join(), /#T40 was handed out already/, "once applied, those numbers are taken");
});

function board(threads, messages = []) {
  const b = loadNames(["state", "linkify", "threadHead", "threadRows", "threadPing", "renameWrites", "threadName"]);
  b.state.threads = threads;
  b.state.messages = messages;
  return b;
}

test("page: #T27 links to its thread, an unknown number stays text, never inside an address", () => {
  const b = board([{ id: "collector-create-task", num: 27 }]);
  assert.equal(b.linkify("see #T27."), 'see <a href="#" class="t-ref" data-tref="collector-create-task">#T27</a>.');
  assert.equal(b.linkify("see #T28"), "see #T28");
  assert.match(b.linkify("https://example.com/#T27"), /^<a href="https:\/\/example\.com\/#T27" target="_blank" rel="noopener">https:\/\/example\.com\/#T27<\/a>$/);
  assert.equal(b.linkify("x#T27 #T270"), "x#T27 #T270");
  for (const u of ["https://x.com/a,#T27", "https://x.com/a!#T27", "https://x.com/(a)#T27", "see example.com/a+#T27"]) {
    const html = b.linkify(u);
    assert.doesNotMatch(html, /<a [^>]*<a |href="[^"]*<|t-ref[^<]*<\/a>[^<]*<\/a>/, `no link inside a link: ${html}`);
  }
});

test("page: a thread's name and number, escaped; a short cut of its text when it has no name", () => {
  const evil = '<img src=x onerror=alert(1)>"';
  const b = board([{ id: "t-1", num: 3, title: evil }], [{ id: "m1", thread: "t-1", from: "Sam", text: "q", at: 1 }]);
  const head = b.threadHead("t-1", "wait");
  assert.match(head, /<span class="t-name">&lt;img src=x onerror=alert\(1\)&gt;&quot;<\/span>/);
  assert.match(head, /data-copy="#T3"/);
  assert.doesNotMatch(head + b.threadRows(10).open + b.threadRows(10).answered, /<img src=x/);
  const long = board([], [{ id: "m1", thread: "t-2", from: "Sam", text: "Why does the collector need two folders outside its own when it runs every hour on the Studio", at: 1 }]);
  assert.equal(long.threadName("t-2"), "Why does the collector need two folders outside its own…");
  assert.doesNotMatch(long.threadHead("t-2", "wait"), /t-name|data-copy/, "no name of its own, no number yet: just Rename");
});

test("page: the ping names the threads a message refers to, so Manager reads them first; Rename writes the title only", () => {
  const b = board([{ id: "collector-create-task", num: 27 }, { id: "t-9", num: 9 }]);
  assert.equal(b.threadPing("t-9", "same as #T27 and #T27, not #T99", ""), "Board thread [t-9] #T9: Owner: same as #T27 and #T27, not #T99 [Refs: #T27 = collector-create-task: read those threads first]");
  assert.equal(b.threadPing("t-9", "x".repeat(3000), "").length, 1900);
  assert.deepEqual(JSON.parse(JSON.stringify(b.renameWrites("t-9", "  Collector   setup "))), [{ op: "update", path: "threads/t-9", data: { title: "Collector setup" } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.renameWrites("t-new", "x"))), [{ op: "set", path: "threads/t-new", data: { title: "x" } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.renameWrites("t-9", "   "))), []);
});

test("the gate reads each write's pin (if_version), alone or in a batch", () => {
  assert.equal(writesOf({ action: "update", collection: "meta", doc_id: "threadSeq", data: { next: 3 }, if_version: 4 })[0].if_version, 4);
  assert.deepEqual(writesOf({ action: "batch", writes: [{ op: "update", collection: "meta", doc_id: "threadSeq", data: { next: 3 }, if_version: 5 }, { op: "set", collection: "threads", doc_id: "a", data: { num: 2 } }] }).map((w) => w.if_version), [5, undefined]);
});

test("the after-write hook: only an applied write to this board's counter changes the gate's memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-after-"));
  try {
    const cfg = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", gate: { stateDir: dir } });
    const url = "https://claude.ai/" + "artifact/TestBoard01";
    assert.equal(after({ tool_name: "ArtifactData", tool_input: { url: "https://claude.ai/" + "artifact/Other01", action: "update", collection: "meta", doc_id: "threadSeq", data: { next: 9 }, if_version: 1 } }, { config: cfg }), null, "another board");
    assert.equal(after({ tool_name: "ArtifactData", tool_input: { url, action: "get", collection: "meta", doc_id: "threadSeq" } }, { config: cfg }), null, "a read");
    after({ tool_name: "ArtifactData", tool_input: { url, action: "batch", writes: [{ op: "set", collection: "threads", doc_id: "a", data: { num: 1 } }, { op: "set", collection: "meta", doc_id: "threadSeq", data: { next: 2 } }] } }, { config: cfg });
    assert.equal(JSON.parse(readFileSync(join(dir, "TestBoard01", "gate.json"), "utf8")).threadSeq, 2);
    after({ tool_name: "ArtifactData", tool_input: { url, action: "update", collection: "meta", doc_id: "threadSeq", data: { next: 1 }, if_version: 2 } }, { config: cfg });
    assert.equal(JSON.parse(readFileSync(join(dir, "TestBoard01", "gate.json"), "utf8")).threadSeq, 2, "never lower");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the gate's state is written whole: a file of its own, renamed into place, nothing left behind (Security)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-state-"));
  try {
    const path = join(dir, "b", "gate.json");
    writeState(path, { threadSeq: 3 });
    writeState(path, { threadSeq: 4, journal: [] });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { threadSeq: 4, journal: [] });
    assert.deepEqual(readdirSync(join(dir, "b")), ["gate.json"], "no temporary file left");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a counter raised by after.mjs while the gate's own call ran is kept when the gate saves (Checker)", async () => {
  const { keepCounter } = await import("../gate/gate.mjs");
  assert.equal(keepCounter({ threadSeq: 40, journal: [1] }, { threadSeq: 43 }).threadSeq, 43, "the raise on disk wins");
  assert.deepEqual(JSON.parse(JSON.stringify(keepCounter({ threadSeq: 44, journal: [1] }, { threadSeq: 43 }))), { threadSeq: 44, journal: [1] });
  assert.deepEqual(keepCounter({ journal: [] }, {}), { journal: [] }, "no counter yet: nothing added");
  assert.equal(keepCounter({}, { threadSeq: "9" }).threadSeq, undefined, "only a whole number on disk counts");
  const { saveState } = await import("../gate/gate.mjs");
  const dir = mkdtempSync(join(tmpdir(), "fb-save-"));
  try {
    const path = join(dir, "gate.json");
    writeState(path, { threadSeq: 43 }); // after.mjs, while the gate's call (which read 40) ran
    saveState(path, { threadSeq: 40, journal: ["w"] });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { threadSeq: 43, journal: ["w"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an item's top line shows \"#T<num> · title\" before it opens (board-thread-head; thread-num-always)", () => {
  const b = loadNames(["state", "askHtml", "threadTag", "initRow", "enrich", "gates", "asShown"]);
  b.state.threads = [{ id: "ask-1", num: 27 }, { id: "ask-2", num: 28, title: '<i>Collector</i> setup' }, { id: "card-1", num: 30 }];
  const ask = (id) => ({ id, kind: "action", text: "Run the install", steps: ["x"], since: Date.now() });
  const summary = (html) => html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
  b.state.waiting = [ask("ask-1"), ask("ask-2")];
  assert.match(summary(b.askHtml(ask("ask-1"), new Set())), /<span class="t-tag"><button type="button" class="copy t-num" data-copy="#T27"/);
  assert.match(summary(b.askHtml(ask("ask-1"), new Set())), /#T27<\/button> · <b class="t-name">Run the install<\/b>/, "not renamed: named by the item's own text (thread-num-always)");
  assert.match(summary(b.askHtml(ask("ask-2"), new Set())), /#T28<\/button> · <b class="t-name">&lt;i&gt;Collector&lt;\/i&gt; setup<\/b>/);
  assert.equal(b.threadTag("ask-9"), "", "no number yet and no name: nothing");
  b.state.steps = [];
  const row = b.initRow(b.gates(b.enrich(b.asShown({ id: "card-1", name: "Tabs", status: "active", level: "Quick", skip: [] }))));
  assert.match(row, /<strong>Tabs<\/strong><span class="t-tag"><button[^>]*data-copy="#T30"/);
});
