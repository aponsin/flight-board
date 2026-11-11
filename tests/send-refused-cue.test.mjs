// #C849: a refused send ("Not delivered") gets one cue line to post the same line to the card's thread on the store; nothing else does.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/send-refused-cue.py", import.meta.url));
const run = (input) => {
  const r = spawnSync("python3", [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};

test("a SendMessage answered 'Not delivered' gets the cue to post on the card's thread", () => {
  for (const tool_name of ["SendMessage", "mcp__ccd_session_mgmt__send_message"]) {
    const out = run({ tool_name, tool_input: { to: "Manager", message: "READY" }, tool_response: [{ type: "text", text: "Not delivered: the 10-send cap is reached until the owner next types in this session." }] });
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /post the same line to the card's thread/);
    assert.match(out.hookSpecificOutput.additionalContext, /store's post tool/);
  }
  assert.ok(run({ tool_name: "SendMessage", tool_response: "not delivered" }), "any case, and a plain string result");
});

test("a delivered send, another tool, or a result the hook cannot read gives nothing and never fails", () => {
  assert.equal(run({ tool_name: "SendMessage", tool_response: { success: true, message: "sent to Manager" } }), null);
  assert.equal(run({ tool_name: "Bash", tool_response: "Not delivered" }), null, "only the send tools");
  assert.equal(run({ tool_name: "SendMessage" }), null, "no result");
  assert.equal(run("not json"), null);
  assert.equal(run("[]"), null);
});
