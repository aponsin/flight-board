// #C861 part A (Manager: build part A only): a read-only check of every item of the contract's "Safe to restart" row, with a --dry-run, and no way to
// quit anything. The action (part B) needs the owner's go. Must still hold: an unknown check is never ok, and a force-at time never cuts a ship.
import test from "node:test";
import assert from "node:assert/strict";
import { liveStateFile } from "../scripts/live-state.mjs";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readyVerdict, installRuns, parseForceAt, CHECKS, FORCEABLE, AGENT_QUIET_MS } from "../scripts/restart-ready.mjs";

const T = new Date(2026, 10, 12, 12, 0, 0).getTime(); // local noon, so HH:MM parsing is the same in any zone
const ALL_OK = () => ({
  ship: { runs: [], live: null }, install: 0,
  agents: { Manager: { state: "working", lastActivityAt: T - 1000 }, Builder: { state: "idle", lastActivityAt: T - 10 * 60e3 }, Checker: { state: "idle", lastActivityAt: null } },
  outside: 0, scheduled: 0, github: 0, lock: false, remote: true,
});
const v = (over = {}, extra = {}) => readyVerdict({ readings: { ...ALL_OK(), ...over }, now: T, ...extra });

test("every check ok: it would restart now, and the lead's own activity does not count", () => {
  const r = v();
  assert.equal(r.ok, true);
  assert.equal(r.line, "would restart now: every check is ok");
  assert.deepEqual(r.checks.map((c) => c.name), CHECKS);
  assert.ok(r.checks.every((c) => c.status === "ok"));
  assert.equal(r.first, null);
});

test("each check on its own holds the restart and is the one named", () => {
  const cases = {
    ship: { ship: { runs: [{ pid: 7, startedAt: T - 60e3 }], live: null } },
    install: { install: 1 },
    agents: { agents: { ...ALL_OK().agents, Builder: { state: "working", lastActivityAt: T - 5000 } } },
    outside: { outside: 2 }, scheduled: { scheduled: 1 }, github: { github: 3 }, lock: { lock: true }, remote: { remote: false },
  };
  for (const name of CHECKS) {
    const r = v(cases[name]);
    assert.equal(r.ok, false, name);
    assert.equal(r.first.name, name);
    assert.match(r.line, new RegExp(`^would wait: ${name}: `), name);
    assert.equal(r.checks.filter((c) => c.status !== "ok").length, 1, `only ${name} fails`);
  }
  assert.match(v(cases.ship).line, /Release is shipping/);
  assert.match(v({ ship: { runs: [], live: { card: "x", num: 861, since: T - 1000 } } }).line, /Release is working on #C861/);
  assert.match(v(cases.agents).line, /Builder active in the last 2 min/);
  assert.match(v(cases.remote).line, /the owner could not reach the app/);
});

test("the first failing check named follows the order: ship, install, agents, outside, scheduled, github, lock, remote", () => {
  const r = v({ remote: false, lock: true, github: 1, scheduled: 1, outside: 1, install: 1 });
  assert.equal(r.first.name, "install");
  assert.equal(r.checks.filter((c) => c.status !== "ok").length, 6);
});

test("an agent is active for 2 minutes: 119 s waits, 120 s does not; a working agent waits whatever its time; the lead and a bad role are handled", () => {
  const agents = (a) => ({ agents: { Manager: { state: "working", lastActivityAt: T }, ...a } });
  assert.equal(v(agents({ Builder: { state: "idle", lastActivityAt: T - AGENT_QUIET_MS + 1000 } })).ok, false);
  assert.equal(v(agents({ Builder: { state: "idle", lastActivityAt: T - AGENT_QUIET_MS } })).ok, true);
  assert.equal(v(agents({ Builder: { state: "working", lastActivityAt: null } })).ok, false);
  assert.equal(v(agents({ Builder: { state: "idle" } })).ok, true, "no activity time: not active");
  assert.equal(v({ agents: { Manager: { state: "working" } } }, { lead: "Lead" }).ok, false, "a different lead: Manager is then an agent");
  const odd = v(agents({ "Evil\u001b[31m": { state: "working" } }));
  assert.equal(odd.ok, false); assert.match(odd.line, /\?/); assert.doesNotMatch(odd.line, /\u001b/, "an escape sequence in a role name never reaches the line");
});

test("must still refuse: an unknown reading is never ok (every one the script cannot read on this machine), whatever else holds", () => {
  for (const name of CHECKS) {
    const over = { ship: null, install: null, agents: null, outside: null, scheduled: null, github: null, lock: null, remote: null };
    const readings = { ...ALL_OK(), [name]: over[name] };
    const r = readyVerdict({ readings, now: T });
    assert.equal(r.ok, false, name);
    assert.equal(r.first.status, "unknown");
    assert.match(r.line, /can't read/);
  }
  for (const bad of [undefined, "x", -1, 1.5, NaN]) assert.equal(v({ outside: bad }).ok, false, String(bad));
  assert.equal(v({ lock: "no" }).ok, false, "a lock that is not a boolean");
  assert.equal(v({ remote: "on" }).ok, false);
  assert.equal(readyVerdict({ readings: {}, now: T }).ok, false, "no readings at all");
});

test("force-at: from its time, only people hold nothing; a ship, an install, GitHub, the lock, Remote Control off and any unknown still hold", () => {
  const forceAt = T - 60e3, busy = { agents: { ...ALL_OK().agents, Builder: { state: "working" } }, outside: 1, scheduled: 2 };
  assert.deepEqual(FORCEABLE, ["agents", "outside", "scheduled"]);
  const forced = v(busy, { forceAt });
  assert.equal(forced.ok, true); assert.equal(forced.forced, true);
  assert.match(forced.line, /would restart now: the force time \d\d:\d\d has passed, and only people were holding it \(agents, outside, scheduled\)/);
  const before = v(busy, { forceAt: T + 60e3 });
  assert.equal(before.ok, false); assert.match(before.line, /\(force at \d\d:\d\d\)$/);
  for (const [what, over] of Object.entries({ ship: { ship: { runs: [{ pid: 1, startedAt: T }], live: null } }, install: { install: 1 }, github: { github: 1 }, lock: { lock: true }, remote: { remote: false },
    "an unknown reading": { outside: null }, "a shipping card": { ship: { runs: [], live: { card: "c", num: 1, since: T } } } })) {
    const r = v({ ...busy, ...over }, { forceAt });
    assert.equal(r.ok, false, `${what}: a force never cuts it`);
    assert.match(r.line, /\(a force never yields to this\)$/);
  }
  assert.equal(v({}, { forceAt }).forced, false, "nothing was holding it: not a force");
  assert.equal(v({}, { forceAt: null }).forced, false);
});

test("installRuns counts only the owner's install commands run by node or a shell", () => {
  const ps = [" 11 00:05 node /Users/o/Documents/Board/board-store-deploy-pc40.mjs", " 12 00:02 /usr/local/bin/node /x/board-deploy.mjs pc40 aaa bbb", " 13 01:00 sh /Users/o/board-v3.71-install.sh",
    " 14 00:01 vim board-store-tree-pc40.mjs", " 15 00:03 node /x/other.mjs", " 16 00:03 node /x/board-store-hooks-pc40.mjs"].join("\n");
  assert.equal(installRuns(ps), 4, "deploy, board-deploy, install script, hooks; not an editor or another script");
  assert.equal(installRuns(""), 0);
});

test("parseForceAt takes HH:MM today (local); anything else is null", () => {
  const t = parseForceAt("18:30", T);
  assert.equal(new Date(t).getHours(), 18); assert.equal(new Date(t).getMinutes(), 30); assert.equal(new Date(t).getDate(), new Date(T).getDate());
  assert.equal(new Date(parseForceAt("7:05", T)).getHours(), 7);
  for (const bad of ["", "24:00", "12:60", "noon", "12", "12:5", undefined, null, "12:30pm"]) assert.equal(parseForceAt(bad, T), null, String(bad));
});

test("there is no way to quit anything: the file holds no kill, quit script, app launch or process start other than listing processes", () => {
  const src = readFileSync(new URL("../scripts/restart-ready.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  for (const re of [/osascript/, /process\.kill/, /\bkill(all)?\b/i, /open -a/, /spawn/, /(?<![.\w])exec\s*\(/, /execSync/, /writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync/, /fetch\(|https?:\/\//]) assert.doesNotMatch(code, re, String(re));
  const calls = [...code.matchAll(/execFileSync\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["ps"], "the only program it runs is ps, to list processes");
});

test("the command line: it refuses without --dry-run, with an unknown flag or a bad force time, and with no readable config it says would wait", () => {
  const run = (...a) => spawnSync(process.execPath, [new URL("../scripts/restart-ready.mjs", import.meta.url).pathname, ...a], { encoding: "utf8" });
  const none = run("--config", "/nonexistent/board.config.json");
  assert.equal(none.status, 2); assert.match(none.stderr, /no way to restart or quit anything/);
  assert.equal(run("--config", "/nonexistent/c.json", "--dry-run", "--restart").status, 2, "an unknown flag");
  assert.equal(run("--config", "/nonexistent/c.json", "--dry-run", "now").status, 2, "a stray word");
  assert.equal(run("--config", "/nonexistent/c.json", "--dry-run", "--force-at", "25:00").status, 2);
  const cfg = run("--config", "/nonexistent/c.json", "--dry-run", "--force-at", "23:59");
  assert.equal(cfg.status, 3); assert.match(cfg.stdout, /^would wait: can't read the board's config/);
});

test("F2: with no fresh live state a quiet process list is not 'no ship': the ship check is unknown; a run seen in the list still waits", () => {
  const r = v({ ship: { runs: [], live: undefined } });
  assert.equal(r.ok, false); assert.equal(r.first.name, "ship"); assert.equal(r.first.status, "unknown"); assert.match(r.line, /fresh live state/);
  assert.equal(v({ ship: { runs: [{ pid: 7, startedAt: T - 60e3 }], live: undefined } }).first.status, "wait");
  assert.equal(v({ ship: { runs: [], live: null } }).ok, true, "a fresh state that shows no shipping card is ok");
});

test("F1: the live state is the store's file when it exists and gate.stateDir is not set; a set gate.stateDir wins; the dead old file is then never read", () => {
  const id = "abc123", cfg = { artifactUrl: `https://claude.ai/artifact/${id}`, gate: { stateDir: "/s" } };
  const none = () => false, yes = () => true;
  assert.equal(liveStateFile(cfg, {}, yes), `/s/${id}-store/${id}/state.json`);
  assert.equal(liveStateFile(cfg, {}, none), `/s/${id}/state.json`, "no store file: the old path");
  assert.equal(liveStateFile(cfg, { gate: { stateDir: "/s" } }, yes), `/s/${id}/state.json`, "a stateDir the config sets wins");
  // end to end, on a temp home: the old file is fresh-looking nothing, the store file says Release is shipping; the old one is never read
  const home = mkdtempSync(join(tmpdir(), "rr-home-")), base = join(home, ".flight-board"), conf = join(home, "c.json");
  writeFileSync(conf, JSON.stringify({ artifactUrl: cfg.artifactUrl }));
  mkdirSync(join(base, id), { recursive: true }); mkdirSync(join(base, `${id}-store`, id), { recursive: true });
  const put = (p, state) => writeFileSync(join(base, p, "state.json"), JSON.stringify(state));
  const run = () => spawnSync(process.execPath, [new URL("../scripts/restart-ready.mjs", import.meta.url).pathname, "--config", conf, "--dry-run"], { encoding: "utf8", env: { ...process.env, HOME: home } });
  put(id, { board: { at: Date.now() }, agents: { Dead: { state: "working", lastActivityAt: Date.now() } }, cards: {} });
  put(`${id}-store/${id}`, { board: { at: Date.now() }, agents: { Builder: { state: "idle", lastActivityAt: null } }, cards: {} });
  const out = run().stdout;
  assert.match(out, /^ok   agents: /m, "the store file is read");
  assert.doesNotMatch(out, /Dead/, "the dead old file is never read when the store file exists");
  // the store file gone stale: unknown, never ok, even though the old file looks fresh? no: the store file still decides
  put(`${id}-store/${id}`, { board: { at: Date.now() - 10 * 60e3 }, agents: {}, cards: {} });
  assert.match(run().stdout, /^\?\?\?\? ship: /m, "a stale store file reads as unknown");
  // no store folder at all: the old path is the fallback, and when it is stale it also reads as unknown
  rmSync(join(base, `${id}-store`), { recursive: true });
  put(id, { board: { at: Date.now() - 10 * 60e3 }, agents: {}, cards: {} });
  const old = run();
  assert.match(old.stdout, /^\?\?\?\? ship: /m); assert.match(old.stdout, /^\?\?\?\? agents: /m); assert.equal(old.status, 3);
});

test("F3 and a past force time: the command line guards the live state's freshness, and a force time already past is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-")), id = "abc123", cfg = join(dir, "c.json");
  writeFileSync(cfg, JSON.stringify({ artifactUrl: `https://claude.ai/artifact/${id}`, gate: { stateDir: dir } }));
  mkdirSync(join(dir, id));
  const run = (...a) => spawnSync(process.execPath, [new URL("../scripts/restart-ready.mjs", import.meta.url).pathname, "--config", cfg, "--dry-run", ...a], { encoding: "utf8" });
  const put = (at) => writeFileSync(join(dir, id, "state.json"), JSON.stringify({ board: { at }, agents: { Builder: { state: "idle", lastActivityAt: null } }, cards: {} }));
  put(Date.now() - 10 * 60e3);
  const stale = run();
  assert.match(stale.stdout, /^\?\?\?\? ship: can't read a fresh live state/m, "a stale state: the ship check is unknown");
  assert.match(stale.stdout, /^\?\?\?\? agents: /m, "a stale state: the agents are unknown");
  assert.equal(stale.status, 3);
  put(Date.now());
  const fresh = run();
  assert.match(fresh.stdout, /^ok   agents: /m, "a fresh state: the agents are read");
  assert.doesNotMatch(fresh.stdout, /^\?\?\?\? (ship|agents):/m);
  const nowD = new Date();
  if (nowD.getHours() || nowD.getMinutes()) { const past = run("--force-at", "00:00"); assert.equal(past.status, 2); assert.match(past.stderr, /already passed/); }
});
