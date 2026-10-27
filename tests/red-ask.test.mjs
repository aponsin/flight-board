// The red-ask Stop hook (hooks/red-ask-board.py, the owner's install copies it to ~/.claude/hooks): run on made-up
// transcripts. The answer rule's checks are the ones its own test_red_ask.py held before it came here (#C329).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/red-ask-board.py", import.meta.url));
// The hook's verdict on a turn: "" when it lets the turn end, else its reason.
export function hook(lines) {
  const dir = mkdtempSync(join(tmpdir(), "fb-redask-"));
  try {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = spawnSync("python3", [HOOK], { input: JSON.stringify({ transcript_path: path }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).reason : "";
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const turn = (calls, { text = "Is the gate live?", title = "Manager", results = [] } = {}) => [
  { type: "custom-title", customTitle: title },
  { type: "user", message: { content: [{ type: "text", text }] } },
  { type: "assistant", message: { content: calls.map((input, n) => ({ type: "tool_use", id: `t${n}`, name: "ArtifactData", input })) } },
  ...results.map(([n, content]) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content }] } })),
  { type: "assistant", message: { content: [{ type: "text", text: "Not yet." }] } },
];

// The waiting read (#C329): only the open items, whole. A day of items was ~80 (~4k tokens a turn); the open ones are ~6.
const OPEN = { action: "query", collection: "waiting", query: { where: [["done", "==", false]], limit: 1000 } };
const docs = (items) => `${items.length} documents from collection "waiting":\n=== BEGIN ARTIFACT DB x ===\n${items.map((d) => JSON.stringify({ id: d.id, data: d, version: 2 })).join("\n")}\n=== END ARTIFACT DB x ===`;
const item = (id, extra = {}) => ({ id, kind: "decision", question: "q", since: 1, done: false, ...extra });
const answered = item("w-a", { response: { status: "chose", option: "A" } });
// A turn with no question, so only the waiting rule speaks.
const quiet = (calls, results) => turn(calls, { text: "status", results });

test("the waiting read is the open items whole: where done == false alone, limit 1000 or more, no out_dir", () => {
  assert.doesNotMatch(hook(quiet([OPEN], [[0, docs([])]])), /waiting items/);
  const no = /read the board's open waiting items this turn/;
  assert.match(hook(quiet([], [])), no, "no read");
  assert.match(hook(quiet([], [])), /where done == false, limit 1000, no out_dir/, "the refusal says how");
  const day = { action: "query", collection: "waiting", query: { where: [["since", ">", 1]] }, out_dir: "/tmp/x" };
  assert.match(hook(quiet([day], [[0, docs([])]])), no, "the old day-back read with out_dir no longer counts");
  assert.match(hook(quiet([{ action: "list", collection: "waiting" }], [[0, docs([])]])), no, "a list is one page");
  assert.match(hook(quiet([{ ...OPEN, query: { where: OPEN.query.where } }], [[0, docs([])]])), no, "no limit: one page of 100");
  assert.match(hook(quiet([{ ...OPEN, out_dir: "/tmp/x" }], [[0, docs([])]])), no, "out_dir lists 50 paths");
  assert.match(hook(quiet([{ ...OPEN, query: { ...OPEN.query, where: [["done", "==", false], ["kind", "==", "answer"]] } }], [[0, docs([])]])), no, "a narrower read misses items");
  assert.match(hook(quiet([{ action: "get", collection: "waiting", doc_id: "w-a" }], [[0, docs([])]])), no, "one item");
  assert.match(hook(quiet([OPEN], [[0, `${docs([])}\n[12 more saved documents, at /x/<doc_id>.json each]`]])), no, "a result cut short");
  assert.match(hook(quiet([OPEN], [[0, `${docs([])}\nnext_cursor: "abc"`]])), no, "a next page");
  assert.doesNotMatch(hook(quiet([{ ...OPEN, query: { ...OPEN.query, where: [["done", "eq", false]] } }], [[0, docs([])]])), /waiting items/, "eq is ==");
  assert.match(hook(quiet([{ ...OPEN, query: { ...OPEN.query, order_by: { field: "since" } } }], [[0, `${docs([])}\n[ordered queries return one page: these are the first 1000 by "since" — more may exist.]`]])), no, "an ordered page that says more may exist");
});

test("Checker: a cut marker counts only on the board's own lines, never inside a document's text", () => {
  for (const q of ["Makaan will send more documents tomorrow", "[2 more to check]", "next_cursor is a field name"]) {
    assert.doesNotMatch(hook(quiet([OPEN], [[0, docs([item("w-q", { question: q })])]])), /waiting items/, q);
  }
});

test("an open item the owner answered refuses the stop until it is acted on; ack, done or written this turn don't", () => {
  assert.match(hook(quiet([OPEN], [[0, docs([answered, item("w-b")])]])), /answered these board items and they're still open: w-a\./);
  assert.doesNotMatch(hook(quiet([OPEN], [[0, docs([item("w-c", { response: { status: "ack" } })])]])), /still open/);
  const acted = { action: "update", collection: "waiting", doc_id: "w-a", data: { done: true }, if_version: 2 };
  assert.doesNotMatch(hook(quiet([OPEN, acted], [[0, docs([answered])]])), /still open/);
  // A document line is the board's ({id, data, version}); a bare object in the text is not one.
  assert.doesNotMatch(hook(quiet([OPEN], [[0, `0 documents\n${JSON.stringify({ id: "w-z", data: answered })}`]])), /still open/);
});

test("a result saved to a file is read whole from this session's tool-results, or counts as no read", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-redask-saved-"));
  try {
    const results = join(dir, "s", "tool-results"), full = docs([answered]);
    spawnSync("mkdir", ["-p", results]);
    writeFileSync(join(results, "big.txt"), full);
    writeFileSync(join(dir, "elsewhere.txt"), full);
    const preview = (p) => `<persisted-output>\nOutput too large (40KB). Full output saved to: ${p}\n\nPreview (first 2KB):\n${full.slice(0, 40)}\n…\n</persisted-output>`;
    const run = (p) => {
      const path = join(dir, "s.jsonl");
      writeFileSync(path, quiet([OPEN], [[0, preview(p)]]).map((l) => JSON.stringify(l)).join("\n") + "\n");
      const r = spawnSync("python3", [HOOK], { input: JSON.stringify({ transcript_path: path }), encoding: "utf8" });
      return r.stdout.trim() ? JSON.parse(r.stdout).reason : "";
    };
    assert.match(run(join(results, "big.txt")), /still open: w-a\./, "the saved file is the result");
    assert.match(run(join(dir, "elsewhere.txt")), /read the board's open waiting items/, "a file elsewhere: no read");
    assert.match(run(join(results, "gone.txt")), /read the board's open waiting items/, "a file gone: no read");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the answer rule: the owner's question needs a board answer, in a thread or an ans- item; Manager is the title", () => {
  assert.match(hook(turn([])), /asked a question this turn/);
  assert.doesNotMatch(hook(turn([{ action: "set", collection: "messages", doc_id: "m1", data: { thread: "w1", from: "Manager", text: "Not yet.", at: 1 } }])), /asked a question/);
  assert.doesNotMatch(hook(turn([{ action: "batch", writes: [{ op: "set", collection: "messages", doc_id: "m1", data: { thread: "w1" } }] }])), /asked a question/);
  assert.doesNotMatch(hook(turn([{ action: "set", collection: "waiting", doc_id: "ans-gate", data: { kind: "answer" } }])), /asked a question/);
  assert.match(hook(turn([{ action: "list", collection: "messages" }])), /asked a question this turn/, "a read of messages isn't an answer");
  const builder = hook(turn([], { title: "Builder", text: "/pickup Manager quoted in a test? <command-name>/pickup</command-name><command-args>Manager</command-args>" }));
  assert.doesNotMatch(builder, /asked a question|memory tile/, "Builder isn't Manager");
});
