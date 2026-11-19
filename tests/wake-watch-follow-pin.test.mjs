// #C1240 (11-18: every role's watch ended "stale pin" after each of six installs and had to be re-armed by hand): a watch armed with --pinned follows the pin by itself. The launcher stays up, the
// watch under it ends quietly when the pin moves, and the launcher starts the new pin's copy. Real processes: the real wake-watch.mjs as the launcher, fake installs under a scratch HOME
// (a copy for each pin that prints who it is and ends with the quiet code when the settings stop pinning it), fictional shas.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { followStep, STALE_EXIT, FOLLOW_ENV, FOLLOW_MAX, FOLLOW_WINDOW_MS, watchLook, staleLine } from "../scripts/wake-watch.mjs";

const REAL = new URL("../scripts/wake-watch.mjs", import.meta.url).pathname;
const sha = (c) => c.repeat(40);
const A = sha("a"), B = sha("b"), C = sha("c");
const settingsFor = (pin) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node /home/x/.flight-board/install/${pin}/gate/stop.mjs --store` }] }] } });

test("followStep: a quiet stale exit starts the new pin's copy; any other end ends the launcher the same way; a pin that moves over and over ends it with a line", () => {
  assert.deepEqual(followStep({ code: STALE_EXIT }, [], 1000), { again: true, recent: [1000] });
  assert.deepEqual(followStep({ code: 0 }, [], 1000), { again: false, code: 0 }, "a DISPATCH line printed: the agent is woken, the launcher ends with it");
  assert.deepEqual(followStep({ code: 1 }, [], 1000), { again: false, code: 1 });
  assert.deepEqual(followStep({ code: null, signal: "SIGTERM" }, [], 1000), { again: false, code: 1 });
  assert.deepEqual(followStep({ error: new Error("spawn") }, [], 1000), { again: false, code: 1 });
  let recent = [], now = 1000;
  for (let i = 0; i < FOLLOW_MAX; i++) { const s = followStep({ code: STALE_EXIT }, recent, now += 1000); assert.equal(s.again, true); recent = s.recent; }
  const loop = followStep({ code: STALE_EXIT }, recent, now + 1000);
  assert.equal(loop.again, false); assert.equal(loop.code, 1); assert.match(loop.why, /changed \d+ times/);
  const later = followStep({ code: STALE_EXIT }, recent, now + FOLLOW_WINDOW_MS + 5000);
  assert.equal(later.again, true, "old changes fall out of the window: six installs in a day are not a loop");
});

test("the stale check itself is unchanged: with no launcher it still prints its line and ends the watch (the safety of a pin check)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-follow-state-"));
  const first = watchLook(dir, "Builder", A, settingsFor(B), 1000);
  assert.equal(first.stale, true); assert.equal(first.line, staleLine(A, B));
  assert.equal(watchLook(dir, "Builder", A, settingsFor(A), 2000), null, "on the pinned install: no stale line, the tick runs");
});

function world() {
  const home = mkdtempSync(join(tmpdir(), "fb-follow-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const setPin = (pin) => writeFileSync(join(home, ".claude", "settings.json"), settingsFor(pin));
  // A fake install for each pin: prints "RUNNING <pin letter>", then looks at the settings twice a second; when the settings no longer pin it, ends with STALE_EXIT and prints nothing (as the real copy does under the launcher).
  for (const pin of [A, B, C]) {
    mkdirSync(join(home, ".flight-board", "install", pin, "scripts"), { recursive: true });
    writeFileSync(join(home, ".flight-board", "install", pin, "scripts", "wake-watch.mjs"), `
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
console.log("RUNNING ${pin[0]} follow=" + process.env.${FOLLOW_ENV});
setInterval(() => {
  const s = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8");
  if (!s.includes("install/${pin}/")) process.exit(${STALE_EXIT});
}, 100);
`);
  }
  setPin(A);
  const out = [];
  const launcher = spawn(process.execPath, [REAL, "--pinned", "--config", "/nonexistent", "--role", "Builder", "--once"], { env: { ...process.env, HOME: home, [FOLLOW_ENV]: "" }, stdio: ["ignore", "pipe", "pipe"] });
  launcher.stdout.on("data", (d) => out.push(String(d)));
  launcher.stderr.on("data", (d) => out.push(String(d)));
  let exited = null; launcher.on("exit", (code) => { exited = code; });
  const until = async (re, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(out.join(""))) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  return { setPin, out, launcher, until, exited: () => exited };
}

test("changing the pin while a --pinned watch runs leaves a watch running on the new pin, with no stale line and no exit", async () => {
  const w = world();
  try {
    assert.ok(await w.until(/RUNNING a follow=1/), `the pinned copy runs as the launcher's child: ${w.out.join("")}`);
    w.setPin(B);
    assert.ok(await w.until(/RUNNING b follow=1/), `the new pin's copy is started by itself: ${w.out.join("")}`);
    w.setPin(C);
    assert.ok(await w.until(/RUNNING c follow=1/), "and again for a third install");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(w.exited(), null, "the launcher is still running: nobody is woken");
    assert.ok(!/stale pin/.test(w.out.join("")), `no stale-pin line: ${w.out.join("")}`);
  } finally { w.launcher.kill("SIGTERM"); }
});

test("a pin whose install has no wake-watch ends the launcher with a line (not a silent loop), and a --pinned start with no settings arms nothing", async () => {
  const w = world();
  try {
    assert.ok(await w.until(/RUNNING a/));
    w.setPin(sha("d"));
    assert.ok(await w.until(/has no scripts\/wake-watch\.mjs; the watch ends/), w.out.join(""));
    const t = Date.now(); while (w.exited() === null && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.exited(), 1);
  } finally { w.launcher.kill("SIGTERM"); }
  const empty = mkdtempSync(join(tmpdir(), "fb-follow-none-"));
  const run = await new Promise((resolve) => { let text = ""; const p = spawn(process.execPath, [REAL, "--pinned", "--config", "/nonexistent", "--role", "Builder", "--once"], { env: { ...process.env, HOME: empty, [FOLLOW_ENV]: "" }, stdio: ["ignore", "pipe", "pipe"] }); p.stderr.on("data", (d) => { text += d; }); p.on("exit", (code) => resolve({ code, text })); });
  assert.equal(run.code, 1); assert.match(run.text, /nothing armed/);
});

test("only the pinned install is ever started, and the quiet exit is for a launcher's child alone", () => {
  const text = readFileSync(REAL, "utf8");
  assert.match(text, /pinnedLaunch\(\{ settingsText: settingsNow\(\), installRoot, self:/, "every start goes through pinnedLaunch: <install root>/<the one pinned sha>/scripts/wake-watch.mjs");
  assert.match(text, /got\?\.stale && process\.env\[FOLLOW_ENV\] === "1"\) \{ stop\(\); process\.exit\(STALE_EXIT\)/, "a copy not started by the launcher keeps the stale line");
  assert.equal((text.match(/spawn\(process\.execPath/g) || []).length, 1, "one place starts a copy");
});
