// The v3.50 install stopped at "Bootstrap failed: 5: Input/output error": launchctl bootout returns before the job is gone,
// and the bootstrap that followed it at once raced it. The job is now waited out, and the bootstrap tried once more.
import test from "node:test";
import assert from "node:assert/strict";
import { reloadJob, BOOT_WAIT_MS, BOOT_RETRY_MS } from "../scripts/state-install.mjs";

// A stand-in launchd: the job goes away `goneAfter` print calls after the bootout, and a bootstrap while it is there answers 5.
function launchd({ goneAfter = 0, bootstrapFails = 0, bootoutFails = false } = {}) {
  const calls = [], sleeps = [];
  let loaded = true, prints = 0, fails = bootstrapFails, t = 0;
  const launchctl = (args) => {
    calls.push(args[0]);
    if (args[0] === "bootout") { if (bootoutFails) throw new Error("not loaded"); return; }
    if (args[0] === "print") { prints++; if (prints > goneAfter) loaded = false; if (!loaded) throw new Error("not found"); return; }
    if (args[0] === "bootstrap") { if (loaded || fails-- > 0) throw new Error("Bootstrap failed: 5: Input/output error"); calls.push("loaded"); return; }
  };
  return { calls, sleeps, run: (extra = {}) => reloadJob({ target: "gui/501/x", domain: "gui/501", file: "/p.plist", launchctl, sleep: (ms) => { sleeps.push(ms); t += ms; }, now: () => t, ...extra }) };
}

test("the bootstrap waits for the bootout to finish: it is not tried while the job is still there", () => {
  const l = launchd({ goneAfter: 3 });
  l.run();
  assert.deepEqual(l.calls, ["bootout", "print", "print", "print", "print", "bootstrap", "loaded"]);
  assert.equal(l.sleeps.length, 3);
});

test("a job that was not loaded needs no wait; a bootout that fails is no stop", () => {
  const l = launchd({ goneAfter: 0, bootoutFails: true });
  l.run();
  assert.deepEqual(l.calls, ["bootout", "print", "bootstrap", "loaded"]);
  assert.deepEqual(l.sleeps, []);
});

test("one bootstrap failure is tried again after a pause; a second one is the install's stop", () => {
  const once = launchd({ bootstrapFails: 1 });
  once.run();
  assert.deepEqual(once.calls.filter((c) => c === "bootstrap"), ["bootstrap", "bootstrap"]);
  assert.deepEqual(once.sleeps, [BOOT_RETRY_MS]);
  const twice = launchd({ bootstrapFails: 2 });
  assert.throws(() => twice.run(), /5: Input\/output error/);
});

test("the wait has an end: a job that never goes away is bootstrapped anyway after the limit, and its error stops the install", () => {
  const l = launchd({ goneAfter: 1e9 });
  assert.throws(() => l.run(), /5: Input\/output error/);
  assert.ok(l.sleeps.reduce((a, b) => a + b, 0) >= BOOT_WAIT_MS, "it waited the limit");
});
