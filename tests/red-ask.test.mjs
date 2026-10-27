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

// #C334: the waiting read and the memory tile left this hook (the Stop gate sees open asks itself; the Collector
// writes the tile). A Manager turn with no question, no red ask, no read and a context far from its tile: nothing to say.
test("no read and no tile are asked of Manager any more", () => {
  const lines = turn([], { text: "status" });
  lines[2].message.usage = { input_tokens: 900000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  assert.equal(hook(lines), "");
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
