// #C1165 (Manager's audit 11-17, after three roles re-armed on old or moving installs): every board script an agent runs uses the install the Stop hook pins, never `current` or its own checkout.
// (1) wake-watch.mjs --pinned arms from the settings pin, whichever copy of the file the command named; (2) the Stop hook's re-arm line uses it; (3) the builder's push line names the watch's own
// scripts folder, not the checkout; (4) hooks-check refuses `current` as a pin; (5) pickup-watch counts only a watch running the pinned install's copy.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pinnedLaunch } from "../scripts/wake-watch.mjs";
import { watchRoles } from "../scripts/pickup-watch.mjs";
import { dispatchLine } from "../gate/reset.mjs";

const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40), ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const settingsPinning = (home, sha) => `{"hooks":{"Stop":[{"command":"node '${join(home, ".flight-board", "install", sha)}/gate/stop.mjs' --config '/c.json'"}]}}`;

test("pinnedLaunch: the settings' one pinned install, never current or another folder; no pin, two pins or a pinned install with no watch file is a reason, not a launch", () => {
  const home = mkdtempSync(join(tmpdir(), "c1165-"));
  try {
    const installRoot = join(home, ".flight-board", "install");
    for (const sha of [SHA_A, SHA_B]) mkdirSync(join(installRoot, sha, "scripts"), { recursive: true });
    writeFileSync(join(installRoot, SHA_B, "scripts", "wake-watch.mjs"), "// B\n");
    mkdirSync(join(home, ".flight-board", "current", "scripts"), { recursive: true });
    writeFileSync(join(home, ".flight-board", "current", "scripts", "wake-watch.mjs"), "// current\n");
    const own = join(installRoot, SHA_A, "scripts", "wake-watch.mjs"); writeFileSync(own, "// A\n");
    const pinB = pinnedLaunch({ settingsText: settingsPinning(home, SHA_B), installRoot, self: own });
    assert.equal(pinB.file, join(installRoot, SHA_B, "scripts", "wake-watch.mjs"));
    assert.equal(pinB.here, false, "an old copy hands over");
    assert.equal(pinnedLaunch({ settingsText: settingsPinning(home, SHA_B), installRoot, self: pinB.file }).here, true, "the pinned copy runs itself");
    assert.equal(pinnedLaunch({ settingsText: `node '${join(home, ".flight-board", "current")}/gate/stop.mjs'`, installRoot, self: own }).why !== undefined, true, "current is no pin");
    assert.equal(pinnedLaunch({ settingsText: `${settingsPinning(home, SHA_A)}\n${settingsPinning(home, SHA_B)}`, installRoot, self: own }).why !== undefined, true, "two pins are none");
    assert.match(pinnedLaunch({ settingsText: settingsPinning(home, SHA_A.replace(/a/g, "c")), installRoot, self: own }).why, /has no scripts\/wake-watch\.mjs/);
    assert.match(pinnedLaunch({ settingsText: null, installRoot, self: own }).why, /no single install/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("wake-watch --pinned, run for real: it hands the same arguments (without --pinned) to the pinned install's copy and never to current; with no pin it arms nothing and says so", () => {
  const home = mkdtempSync(join(tmpdir(), "c1165-"));
  try {
    const stub = (dir, word) => { mkdirSync(join(dir, "scripts"), { recursive: true }); writeFileSync(join(dir, "scripts", "wake-watch.mjs"), `console.log(${JSON.stringify(word)} + " " + JSON.stringify(process.argv.slice(2)));\n`); };
    stub(join(home, ".flight-board", "install", SHA_B), "PINNED");
    stub(join(home, ".flight-board", "current"), "CURRENT");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const run = (extra = []) => spawnSync(process.execPath, [join(ROOT, "scripts", "wake-watch.mjs"), "--pinned", "--config", "/c.json", "--role", "Builder", "--once", ...extra], { encoding: "utf8", env: { ...process.env, HOME: home } });
    writeFileSync(join(home, ".claude", "settings.json"), settingsPinning(home, SHA_B));
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), `PINNED ${JSON.stringify(["--config", "/c.json", "--role", "Builder", "--once"])}`, "the pinned copy ran with the arguments, --pinned dropped");
    assert.doesNotMatch(ok.stdout, /CURRENT/);
    writeFileSync(join(home, ".claude", "settings.json"), `node '${join(home, ".flight-board", "current")}/gate/stop.mjs'`);
    const none = run();
    assert.equal(none.status, 1);
    assert.match(none.stderr, /--pinned: the Stop hook names no single install in the settings; nothing armed/);
    assert.equal(none.stdout, "", "nothing ran, current included");
    // #C1166 (Checker 2's LOW on #C1165): with a config that does not exist the watch exits 1 whatever --pinned does, so that run proves little. The exit after "nothing armed" is what keeps
    // a copy on current from arming itself: with it gone the watch goes on to read the config, so the run must end on that one line and nothing after it.
    assert.equal(none.stderr.trim().split("\n").length, 1, `no other line after "nothing armed": ${none.stderr}`);
    const cfg = join(home, "board.config.json");
    writeFileSync(cfg, "{}");
    const real = spawnSync(process.execPath, [join(ROOT, "scripts", "wake-watch.mjs"), "--pinned", "--config", cfg, "--role", "Builder", "--once"], { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 20000 });
    assert.equal(real.status, 1);
    assert.equal(real.stderr.trim().split("\n").length, 1, `with a real config too: ${real.stderr}`);
    assert.equal(real.stdout, "");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the builder's push line names the scripts folder of the watch's own line, not the checkout's scripts/stack-ready.mjs", () => {
  const line = dispatchLine({ card: "c1-one", role: "Builder", num: 1, step: "build", phase: "build", level: 1, since: 0, stackMode: true });
  assert.match(line, /node <the scripts folder of your wake-watch line>\/stack-ready\.mjs --config <the board\.config\.json path of your wake-watch line>, run inside your worktree/);
  assert.doesNotMatch(line, /node scripts\/stack-ready\.mjs/);
});

test("pickup-watch counts a watch only on the pinned install when the settings name one: an older install, current or a checkout is not armed", () => {
  const ps = [
    `node /h/.flight-board/install/${SHA_B}/scripts/wake-watch.mjs --config /c.json --role 'Builder' --once`,
    `node /h/.flight-board/install/${SHA_A}/scripts/wake-watch.mjs --config /c.json --role 'Checker' --once`,
    `node /h/.flight-board/current/scripts/wake-watch.mjs --config /c.json --role 'Security' --once`,
    `node /h/Documents/Code/flight-board/scripts/wake-watch.mjs --config /c.json --role 'Release' --once`,
  ].join("\n");
  assert.deepEqual([...watchRoles(ps, SHA_B)], ["Builder"]);
  assert.deepEqual([...watchRoles(ps)].sort(), ["Builder", "Checker", "Release", "Security"], "no pin known: every watch counts, as before");
  assert.deepEqual([...watchRoles(ps, "not-a-sha")].sort(), ["Builder", "Checker", "Release", "Security"], "a malformed pin is no pin");
});

test("no board script or text an agent runs names current, or scripts/stack-ready.mjs from the checkout, as the way to run it (gate hooks and reset text)", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f) => readFileSync(join(ROOT, f), "utf8");
  assert.doesNotMatch(read("gate/reset.mjs"), /node scripts\/stack-ready\.mjs/);
  assert.match(read("gate/stop.mjs"), /--once --pinned/);
  assert.match(read("scripts/hooks-check.mjs"), /follows every release/);
});
