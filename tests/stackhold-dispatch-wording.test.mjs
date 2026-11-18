// #C1228 (11-18: #C1225's builder was woken on every re-arm with "it has nothing pushed" while its tip was pushed and fully signed: stack-ready had refused the commit for a Board-Id
// trailer in the wrong paragraph, so no READY covered it and the probe kept stackHold). A pushed tip that no READY covers is a builder turn that asks for the signal, by name.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_READY_TEXT, DISPATCH_STEPS } from "../gate/reset.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Builder", "Checker", "Security", "Release"], LEAD = "Manager";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const SHA = "784c918c5067", FULL = "784c918c50671cd68c71752ce60824d1520828fa";
const card = { id: "c1-logs", num: 1, owner_role: "Builder", review_level: "Full", waiting_on: null, paused: 0, dropped: 0, repo: "" };
const world = (ev, on = true) => ({
  cards: [card], asks: [], stackSwitch: [{ repo: "board", stack: on, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, "cards.c1-logs": { readAt: NOW - 5_000, value: ev } },
});
const items = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "c1228-")), roster: ROSTER, lead: LEAD, now: NOW }).items;
const pushed = { lit: ["build"], phase: "build", headSha12: SHA, headSha: FULL, headBranch: "build/c1-logs", repoFull: "o/r", signed: [], onMain: false, stackHold: true };

test("a pushed tip with no READY over it is the builder's turn, marked ready and naming the commit; the line no longer says nothing is pushed", () => {
  const [i] = items(world(pushed));
  assert.equal(i.role, "Builder"); assert.equal(i.step, "build"); assert.equal(i.ready, true); assert.equal(i.sha, SHA);
  const line = dispatchLine(i);
  assert.match(line, new RegExp(`commit ${FULL}`));
  assert.match(line, /is pushed, but no READY covers this tip/);
  assert.match(line, /Board-Id and Co-Authored-By together/);
  assert.doesNotMatch(line, /nothing pushed/);
  assert.match(line, /stack-ready\.mjs/);
});

test("nothing pushed, a WIP start push, and the switch off keep the old build line", () => {
  const none = items(world({ lit: [], phase: "build" }))[0];
  assert.equal(none.ready, undefined);
  assert.match(dispatchLine(none), /has nothing pushed/);
  const wip = items(world({ ...pushed, wipHead: true }))[0];
  assert.equal(wip.ready, undefined, "a WIP start push is a build in progress");
  assert.match(dispatchLine(wip), /has nothing pushed|build it and push/);
  const off = items(world({ ...pushed, stackHold: undefined }))[0];
  assert.equal(off.ready, undefined, "a tip with no hold is not asked for a READY");
  const sw = items(world(pushed, false))[0];
  assert.equal(sw.ready, undefined, "the switch off: no stack, no signal to ask for");
});

test("the line is built only from the fixed texts: a ready flag with no sha, or on another step, changes nothing", () => {
  const base = { card: "c1-logs", role: "Builder", level: 1, since: 1, phase: "build", num: 1 };
  assert.match(dispatchLine({ ...base, step: "build", ready: true }), /has nothing pushed/, "no sha: the old text");
  assert.match(dispatchLine({ ...base, step: "review", ready: true, sha: SHA }), /review it/, "another step keeps its own text");
  assert.equal(DISPATCH_STEPS.build, "has nothing pushed; build it and push the branch (the push is the READY)");
  assert.doesNotMatch(DISPATCH_READY_TEXT, /[\r\n]/);
});

test("keeper/TASK.md says it is retired and that nothing writes pickedAt any more", () => {
  const doc = readFileSync(new URL("../keeper/TASK.md", import.meta.url), "utf8");
  assert.match(doc, /\*\*Retired \(#C1228\)\.\*\*/);
  assert.match(doc, /Nothing writes `agents\.<Title>\.pickedAt` any more/);
});
