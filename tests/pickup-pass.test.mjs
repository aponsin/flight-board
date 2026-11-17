// #C870: the watchdog's one pass over the roster. A role that reset gets one /pickup once it is idle and cleared, never
// while its reset turn runs; a picked-up role gets none; a picked-up idle role with no watch is told to arm it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { passActions, REARM_TEXT } from "../scripts/pickup-watch.mjs";

const row = (o) => ({ role: "Checker", state: "idle", tokens: 0, reset: true, pickedUp: false, watchRunning: false, remoteControl: "on", ...o });
const send = (role, text) => ({ role, do: "send_message", text });

test("a reset, then idle and cleared, gets one pickup", () => {
  assert.deepEqual(passActions([row({})]), [send("Checker", "/pickup Checker")]);
  assert.deepEqual(passActions([row({ tokens: 4_999 })]), [send("Checker", "/pickup Checker")]);
});

test("a pickup is never sent while the reset turn runs", () => {
  assert.deepEqual(passActions([row({ state: "working", tokens: 450_000 })]), []);
  assert.deepEqual(passActions([row({ state: "working", tokens: 0 })]), [], "working at 0 tokens is still a running turn");
});

test("not cleared yet: idle with a big context gets none", () => {
  assert.deepEqual(passActions([row({ tokens: 300_000 })]), []);
});

test("an already-picked-up role gets no /pickup, and a role that did not reset gets none", () => {
  assert.deepEqual(passActions([row({ pickedUp: true, watchRunning: true })]), []);
  assert.deepEqual(passActions([row({ reset: false })]), []);
});

test("after a pickup the watch is running: an idle picked-up role with none armed is told to arm it", () => {
  assert.deepEqual(passActions([row({ pickedUp: true, watchRunning: false })]), [send("Checker", REARM_TEXT)]);
  assert.deepEqual(passActions([row({ pickedUp: true, watchRunning: false, state: "working" })]), [], "not while it works");
  assert.deepEqual(passActions([row({ reset: false, pickedUp: true, watchRunning: true })]), []);
});

test("Remote Control off is set on; on, connecting and unavailable are left alone", () => {
  assert.deepEqual(passActions([row({ reset: false, remoteControl: "off" })]), [{ role: "Checker", do: "set_remote_control", on: true }]);
  for (const s of ["on", "connecting", "unavailable", undefined]) assert.deepEqual(passActions([row({ reset: false, remoteControl: s })]), []);
});

test("a spaced role name is kept, an odd one or an unreadable row is dropped", () => {
  assert.deepEqual(passActions([row({ role: "Checker 2" })]), [send("Checker 2", "/pickup Checker 2")]);
  assert.deepEqual(passActions([row({ role: "bad!role" }), null, {}, "x"]), []);
  assert.deepEqual(passActions("nope"), []);
});

test("the command prints the actions as JSON; anything unreadable is an empty list", () => {
  const run = (arg) => execFileSync("node", ["scripts/pickup-watch.mjs", "--pass", arg], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(run(JSON.stringify([row({})]))), [send("Checker", "/pickup Checker")]);
  assert.equal(run("not json"), "[]");
  assert.equal(run("{}"), "[]");
});
