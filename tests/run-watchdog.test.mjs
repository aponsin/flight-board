import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { armWatchdog, RUN_LIMIT_MS } from "../collector/run-watchdog.mjs";

const MOD = fileURLToPath(new URL("../collector/run-watchdog.mjs", import.meta.url));

test("the limit is 5 minutes", () => assert.equal(RUN_LIMIT_MS, 300_000));

test("it logs, reports to the store and exits 2 when the run outlives the limit", async () => {
  const seen = {};
  await new Promise((resolve) => {
    armWatchdog({ ms: 20, log: (m) => { seen.log = m; }, report: async (r) => { seen.report = r; }, exit: (c) => { seen.exit = c; resolve(); } });
  });
  assert.equal(seen.exit, 2);
  assert.match(seen.log, /timed out/);
  assert.equal(seen.report.reason, "probe-run-timeout");
});

test("a report that never answers does not hold the exit", async () => {
  const t0 = Date.now();
  let code;
  await new Promise((resolve) => {
    armWatchdog({ ms: 10, log: () => {}, report: () => new Promise(() => {}), exit: (c) => { code = c; resolve(); } });
  });
  assert.equal(code, 2);
  assert.ok(Date.now() - t0 < 8_000);
});

test("disarmed in time it never fires", async () => {
  let fired = false;
  const w = armWatchdog({ ms: 30, log: () => {}, exit: () => { fired = true; } });
  w.disarm();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, false);
});

// The real hang: a run awaiting something that never settles while a handle keeps the loop alive. A real child process must
// be stopped by the watchdog with exit code 2 inside the limit.
test("a never-resolving step in a real process exits 2 inside the limit", () => {
  const code = `
    import { armWatchdog } from ${JSON.stringify(MOD)};
    armWatchdog({ ms: 300, log: (m) => console.error(m) });
    setInterval(() => {}, 1000);            // a live handle, as in the hung run
    await new Promise(() => {});            // the step nothing times out
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5_000 });
  assert.equal(r.status, 2, `status ${r.status} signal ${r.signal}`);
  assert.match(r.stderr, /probe run timed out/);
});
