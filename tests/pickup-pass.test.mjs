// #C870: the watchdog's one pass over the roster. The program keeps each role's history itself (a high reading, its own
// /pickup, the role seen working after it, a watch seen armed) and reads the armed watches from `ps`; the watchdog agent
// gives only the session tools' readings (Checker 2's M1 and M2 on 8a27f1be).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passActions, watchRoles, REARM_TEXT } from "../scripts/pickup-watch.mjs";

const row = (role, state, tokens, o = {}) => ({ role, state, tokens, remoteControl: "on", ...o });
const send = (role, text) => ({ role, do: "send_message", text });
// Runs the passes in order, carrying the history and the armed set of each, and returns every pass's actions.
const run = (passes, state = {}) => passes.map(([rows, watching]) => { const r = passActions(rows, state, new Set(watching || [])); state = r.state; return r.actions; });

test("a role seen with a big context, then idle and cleared, gets one pickup, and only one", () => {
  const out = run([[[row("Checker", "working", 300_000)]], [[row("Checker", "idle", 0)]], [[row("Checker", "idle", 0)]], [[row("Checker", "idle", 0)]]]);
  assert.deepEqual(out, [[], [send("Checker", "/pickup Checker")], [], []]);
});

test("a pickup is never sent while the reset turn runs, nor before it is cleared (M2's case: no thread is read)", () => {
  assert.deepEqual(run([[[row("Checker", "idle", 450_000)]], [[row("Checker", "working", 0)]], [[row("Checker", "working", 2_000)]], [[row("Checker", "idle", 300_000)]]]), [[], [], [], []]);
});

test("a role whose history never held a big context gets none (a first run on a cleared session can't tell)", () => {
  assert.deepEqual(run([[[row("Checker", "idle", 0)]], [[row("Checker", "idle", 3_000)]]]), [[], []]);
});

test("the next clear is picked up again, and only after a new big context", () => {
  const out = run([[[row("Checker", "idle", 200_000)]], [[row("Checker", "idle", 0)]], [[row("Checker", "idle", 0)]], [[row("Checker", "idle", 150_000)]], [[row("Checker", "idle", 100)]]]);
  assert.deepEqual(out, [[], [send("Checker", "/pickup Checker")], [], [], [send("Checker", "/pickup Checker")]]);
});

test("M1: three passes send at most one re-arm; a role with no watch ever seen (Manager) is never told", () => {
  const cycle = (watch) => [[[row("Rx", "idle", 300_000)], watch], [[row("Rx", "idle", 0)], []], [[row("Rx", "working", 20_000)], []], [[row("Rx", "idle", 30_000)], []], [[row("Rx", "idle", 30_000)], []], [[row("Rx", "idle", 30_000)], []]];
  const withWatch = run(cycle(["Rx"])), without = run(cycle([]));
  assert.deepEqual(withWatch, [[], [send("Rx", "/pickup Rx")], [], [send("Rx", REARM_TEXT)], [], []]);
  assert.equal(withWatch.flat().filter((a) => a.text === REARM_TEXT).length, 1);
  assert.deepEqual(without, [[], [send("Rx", "/pickup Rx")], [], [], [], []]);
});

test("no re-arm while the watch is armed, nor before the role was seen working after the pickup", () => {
  assert.deepEqual(run([[[row("Rx", "idle", 300_000)], ["Rx"]], [[row("Rx", "idle", 0)], []], [[row("Rx", "idle", 0)], []]]), [[], [send("Rx", "/pickup Rx")], []], "idle again at once: the pickup turn may not have begun");
  assert.deepEqual(run([[[row("Rx", "idle", 300_000)], ["Rx"]], [[row("Rx", "idle", 0)], []], [[row("Rx", "working", 20_000)], ["Rx"]], [[row("Rx", "idle", 30_000)], ["Rx"]]]), [[], [send("Rx", "/pickup Rx")], [], []]);
});

test("Remote Control off is set on; on, connecting and unavailable are left alone", () => {
  assert.deepEqual(passActions([row("Checker", "working", 9_000, { remoteControl: "off" })]).actions, [{ role: "Checker", do: "set_remote_control", on: true }]);
  for (const s of ["on", "connecting", "unavailable", undefined]) assert.deepEqual(passActions([row("Checker", "working", 9_000, { remoteControl: s })]).actions, []);
});

test("a spaced role name is kept, an odd one or an unreadable row is dropped", () => {
  assert.deepEqual(run([[[row("Checker 2", "working", 300_000)]], [[row("Checker 2", "idle", 0)]]])[1], [send("Checker 2", "/pickup Checker 2")]);
  assert.deepEqual(passActions([row("bad!role", "idle", 0), null, {}, "x"]).actions, []);
  assert.deepEqual(passActions("nope").actions, []);
});

test("Security's L3 and L1: a role name is 2 to 24 characters, and a role outside the roster gets nothing", () => {
  const long = "A" + "b".repeat(23), tooLong = "A" + "b".repeat(24);
  assert.deepEqual(run([[[row(long, "working", 300_000)]], [[row(long, "idle", 0)]]])[1], [send(long, `/pickup ${long}`)]);
  assert.deepEqual(run([[[row(tooLong, "working", 300_000)]], [[row(tooLong, "idle", 0)]]]), [[], []]);
  assert.deepEqual(run([[[row("X", "working", 300_000)]], [[row("X", "idle", 0)]]]), [[], []]);
  const roster = new Set(["Checker"]);
  let r = passActions([row("Checker", "working", 300_000), row("Stranger", "working", 300_000, { remoteControl: "off" })], {}, new Set(), roster);
  r = passActions([row("Checker", "idle", 0), row("Stranger", "idle", 0, { remoteControl: "off" })], r.state, new Set(), roster);
  assert.deepEqual(r.actions, [send("Checker", "/pickup Checker")], "Stranger is on no roster: no pickup, no Remote Control");
  assert.equal(r.state.Stranger, undefined);
});

test("the command takes the rows from a file and the roster from the config; no readable roster means nothing is sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pickup-pass-")), state = join(dir, "state.json"), rows = join(dir, "rows.json"), cfg = join(dir, "board.config.json");
  const cmd = (rs, ...extra) => { writeFileSync(rows, JSON.stringify(rs)); return execFileSync("node", ["scripts/pickup-watch.mjs", "--pass", "unused", "--rows-file", rows, "--state", state, ...extra], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim(); };
  writeFileSync(cfg, JSON.stringify({ roster: ["Zed Probe"] }));
  assert.equal(cmd([row("Zed Probe", "working", 300_000), row("Other", "working", 300_000)], "--config", cfg), "[]");
  assert.equal(cmd([row("Zed Probe", "idle", 0), row("Other", "idle", 0)], "--config", cfg), JSON.stringify([send("Zed Probe", "/pickup Zed Probe")]));
  assert.equal(cmd([row("Zed Probe", "idle", 0)], "--config", join(dir, "missing.json")), "[]", "a config that can't be read sends nothing");
  writeFileSync(cfg, JSON.stringify({ nope: 1 }));
  assert.equal(cmd([row("Zed Probe", "idle", 0)], "--config", cfg), "[]", "a config with no roster sends nothing");
});

test("watchRoles reads --role from the wake-watch lines of ps, quoted or not, and tells Checker from Checker 2", () => {
  const ps = [
    "node /Users/x/.flight-board/install/abc/scripts/wake-watch.mjs --config /c/board.config.json --role Boardsmith --once",
    "node /i/scripts/wake-watch.mjs --config '/c/board.config.json' --role 'Checker 2' --once",
    "node /i/scripts/wake-watch.mjs --role Checker",
    "grep --role Manager something-else.mjs",
  ].join("\n");
  assert.deepEqual([...watchRoles(ps)].sort(), ["Boardsmith", "Checker", "Checker 2"]);
  assert.deepEqual([...watchRoles("")], []);
});

test("the command keeps the history in its state file and prints the actions as JSON; anything unreadable is []", () => {
  const dir = mkdtempSync(join(tmpdir(), "pickup-pass-")), file = join(dir, "state.json");
  const cmd = (arg) => execFileSync("node", ["scripts/pickup-watch.mjs", "--pass", arg, "--state", file], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim();
  assert.equal(cmd(JSON.stringify([row("Zed Probe", "working", 300_000)])), "[]");
  assert.equal(cmd(JSON.stringify([row("Zed Probe", "idle", 0)])), JSON.stringify([send("Zed Probe", "/pickup Zed Probe")]));
  assert.equal(cmd(JSON.stringify([row("Zed Probe", "idle", 0)])), "[]", "the second pass finds the pickup in the file");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))["Zed Probe"].sent, true);
  assert.equal(cmd("not json"), "[]");
  assert.equal(cmd("{}"), "[]");
  writeFileSync(file, "not json");
  assert.equal(cmd(JSON.stringify([row("Zed Probe", "idle", 0)])), "[]", "a broken file is an empty history");
});
