// #C1390 (11-20: #C1382 then #C1383 were pushed, the turn wrote "next is X, not started, dispatch watch armed" and went idle; the watch did not fire and the board flagged a stall until Manager said go):
// when stack-ready has just said cards are queued behind this one, a turn that ends on nothing but arming the wake watch is asked once to start the next card. The evidence is the tool's own line
// (never the wording of the reply), and every other later call (a worktree, a commit, an edit, a push) counts as starting.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { stopRun, nextCardCheck } from "../gate/stop.mjs";

const NOW = 1_800_000_000_000;
const config = fullConfig({ roster: ["Manager", "Builder"], gate: { managerRole: "Manager" } });
const WATCH = "node '/x/scripts/wake-watch.mjs' --config c --role Builder --once --pinned";
const READY = "node '/x/scripts/stack-ready.mjs' --config c";
const MORE = "STACK-READY OK: pushed build/stack at 969d8836f1ea, more queued (derive-dead-fields, dispatch-next-card-in-group): no signal";
const GROUP = "STACK-READY OK: pushed build/stack at 969d8836f1ea, waiting for its group board-polish-fifteen (derive-dead-fields not built): no signal";
const SIGNAL = "STACK-READY OK: pushed build/stack at 969d8836f1ea, signal written";
// A turn: a message, then each step is a tool call with its result.
const turn = (...steps) => [
  { type: "user", message: { content: "go on" } },
  ...steps.flatMap(([call, result], n) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: `t${n}`, ...call }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: result ?? "" }] } },
  ]),
  { type: "assistant", message: { content: [{ type: "text", text: "Next is derive-dead-fields, not started, dispatch watch armed." }] } },
];
const bash = (command) => ({ name: "Bash", input: { command } });
const ready = (text) => [bash(READY), text];

test("a turn that ends on stack-ready's 'more queued' and arming the watch is asked to start the next card", () => {
  const r = nextCardCheck(turn(ready(MORE), [{ ...bash(WATCH), input: { command: WATCH, run_in_background: true } }, "started"]));
  assert.match(r.ask, /2 cards of yours are queued behind this one \(#C?derive-dead-fields|derive-dead-fields/);
  assert.match(r.ask, /dispatch-next-card-in-group/);
  assert.match(r.ask, /Start the next card now/);
  assert.match(nextCardCheck(turn(ready(MORE))).ask, /Start the next card now/, "ending right after stack-ready is the same");
});

test("'waiting for its group' counts the same, with one card named in the singular", () => {
  const r = nextCardCheck(turn(ready(GROUP)));
  assert.match(r.ask, /a card of yours is queued behind this one/);
  assert.match(r.ask, /ending without starting it|without starting it/);
});

test("a turn that went on to anything else is not asked, and neither is one with no queued card", () => {
  for (const next of [bash("git -C /x/wt worktree add -b build/y /x/wt2"), { name: "Edit", input: { file_path: "/x/f.mjs" } }, { name: "Write", input: { file_path: "/x/g.mjs" } }, bash("git commit -m x"), bash("git push origin build/stack")]) {
    assert.equal(nextCardCheck(turn(ready(MORE), [next, "ok"])).ask, null, JSON.stringify(next).slice(0, 50));
    assert.equal(nextCardCheck(turn(ready(MORE), [bash(WATCH), ""], [next, "ok"])).ask, null, "arming the watch and then starting is starting");
  }
  assert.equal(nextCardCheck(turn(ready(SIGNAL))).ask, null, "the signal was written: nothing is queued");
  assert.equal(nextCardCheck(turn([bash("npm test"), "ok"])).ask, null, "no stack-ready in the turn");
  assert.equal(nextCardCheck(turn(ready("STACK-READY FAILED: refused: the commit's last paragraph"))).ask, null, "a refusal says nothing about the queue");
  assert.equal(nextCardCheck(turn([bash("echo 'more queued (a)' # stack-ready.mjs"), "more queued (a)"])).ask, null, "only the tool's own line counts");
});

test("only the LAST stack-ready of the turn counts", () => {
  assert.equal(nextCardCheck(turn(ready(MORE), [bash("git commit -m x"), "ok"], ready(SIGNAL))).ask, null);
  assert.notEqual(nextCardCheck(turn(ready(SIGNAL), [bash("git commit -m x"), "ok"], ready(MORE))).ask, null);
});

test("the ids named are card ids only, and an odd id is dropped", () => {
  const r = nextCardCheck(turn(ready("STACK-READY OK: pushed b at 969d8836f1ea, more queued (good-one, BAD ID, `x`): no signal")));
  assert.match(r.ask, /a card of yours is queued/);
  assert.equal(nextCardCheck(turn(ready("STACK-READY OK: pushed b at 969d8836f1ea, more queued (BAD ID): no signal"))).ask, null);
});

test("stopRun carries the ask for a roster role and not for the lead", () => {
  const lines = turn(ready(MORE), [{ name: "Bash", input: { command: WATCH, run_in_background: true } }, "started"]);
  const dispatch = { on: false, alive: true, askedAt: null, command: "x", woken: null, checkedAt: null };
  const run = (role) => stopRun(lines, { config, env: { FLIGHT_BOARD_ROLE: role }, now: NOW, dispatch });
  assert.equal(run("Builder").errs.length, 1);
  assert.match(run("Builder").errs[0], /Start the next card now/);
  assert.deepEqual(run("Manager").errs, []);
});
