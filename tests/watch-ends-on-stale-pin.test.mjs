// #C1158 (11-17: a start push woke the reviewers although #C1139 stops that, because their --once watches had been started from older installs that have no such rule, and a
// --once watch keeps the code it started with until it fires): a watch started from an install other than the one the Stop hook pins prints one line and ends, once per role and pair,
// and every DISPATCH line says which install decided it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installShaOf, pinnedInstallOf, staleCheck, staleLine, withInstall, watchLook } from "../scripts/wake-watch.mjs";
import { dispatchPidFile, dispatchSeenFile, DISPATCH_FILE } from "../gate/reset.mjs";

const OLD = "1".repeat(8) + "a".repeat(32), NEW = "2".repeat(8) + "b".repeat(32);
const settings = (sha) => JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `'/n/node' '/h/.flight-board/install/${sha}/gate/stop.mjs' --config '/c/board.config.json' --store` }] }] } });
const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("installShaOf reads the install folder a path is in; anything else is none", () => {
  assert.equal(installShaOf(`/Users/x/.flight-board/install/${OLD}/scripts/wake-watch.mjs`), OLD);
  assert.equal(installShaOf(`/Users/x/.flight-board/install/${OLD}`), OLD);
  for (const p of ["/Users/x/code/flight-board/scripts/wake-watch.mjs", "/Users/x/.flight-board/current/scripts/wake-watch.mjs", `/x/.flight-board/install/${OLD.slice(0, 39)}/s.mjs`, "", null, undefined]) assert.equal(installShaOf(p), null, String(p));
});

test("pinnedInstallOf is the one install the settings' gate/stop.mjs entries name; none, or two different, is no pin", () => {
  assert.equal(pinnedInstallOf(settings(NEW)), NEW);
  assert.equal(pinnedInstallOf(`${settings(NEW)}\n${settings(NEW)}`), NEW, "the same pin twice is one pin");
  assert.equal(pinnedInstallOf(`${settings(NEW)}\n${settings(OLD)}`), null, "two different pins: no pin");
  for (const t of ["", "{}", null, undefined, `{"x":"/h/.flight-board/install/${NEW}/scripts/wake-watch.mjs"}`]) assert.equal(pinnedInstallOf(t), null, String(t));
});

test("staleCheck: a watch on another install than the pin gets the line once per role and pair; the same install, no pin or no install of its own gets none", () => {
  const dir = mkdtempSync(join(tmpdir(), "stale-pin-"));
  try {
    const line = staleCheck(dir, "Checker 2", OLD, settings(NEW), 1000);
    assert.equal(line, staleLine(OLD, NEW));
    assert.match(line, /stale pin: this watch runs from install 11111111aaaa but the Stop hook pins 22222222bbbb/);
    assert.equal(staleCheck(dir, "Checker 2", OLD, settings(NEW), 2000), null, "the pair was told: a re-arm from the same stale path keeps running (no wake loop)");
    assert.equal(staleCheck(dir, "Security", OLD, settings(NEW), 2000), staleLine(OLD, NEW), "each role is told once");
    assert.equal(staleCheck(dir, "Checker 2", OLD, settings(OLD.replace(/^1/, "3")), 3000)?.includes("3111111"), true, "a new pin is a new pair");
    assert.equal(staleCheck(dir, "Release", NEW, settings(NEW)), null, "on the pin");
    assert.equal(staleCheck(dir, "Release", OLD, "{}"), null, "no pin readable");
    assert.equal(staleCheck(dir, "Release", null, settings(NEW)), null, "not run from an install folder");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("withInstall adds the watch's install to each DISPATCH line and changes no other line", () => {
  assert.equal(withInstall("DISPATCH #C1 at build: x (Builder's turn)", OLD), `DISPATCH #C1 at build: x (Builder's turn) [watch install 11111111aaaa]`);
  assert.equal(withInstall("DISPATCH a\nNUDGE b\nDISPATCH c", OLD), "DISPATCH a [watch install 11111111aaaa]\nNUDGE b\nDISPATCH c [watch install 11111111aaaa]");
  assert.equal(withInstall("DISPATCH a", null), "DISPATCH a", "not run from an install folder: unchanged");
});

// The command as an owner runs it: a copy of the code in an install folder under a temp home, the settings of that home pinning another install.
const run = async (pin, extra = {}) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "stale-run-")));
  const install = join(home, ".flight-board", "install", OLD);
  for (const d of ["scripts", "gate", "collector", "worker"]) cpSync(join(ROOT, d), join(install, d), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), settings(pin));
  const cfgPath = join(home, "board.config.json");
  writeFileSync(cfgPath, JSON.stringify({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", roster: ["Manager", "Builder"], gate: { stateDir: join(home, "state") } }));
  const dir = join(home, "state", "TestBoard01");
  mkdirSync(dir, { recursive: true });
  const start = () => spawn(process.execPath, [join(install, "scripts", "wake-watch.mjs"), "--config", cfgPath, "--role", "Builder", "--once"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home } });
  return { home, dir, start, ...extra };
};
const collect = (child) => { const o = { out: "", err: "" }; child.stdout.on("data", (d) => (o.out += d)); child.stderr.on("data", (d) => (o.err += d)); return o; };

test("as an owner runs it: a watch from an old install ends with the stale line and no pid file, a re-arm from the same path keeps running, one on the pin keeps running", async () => {
  const r = await run(NEW);
  try {
    const first = r.start(), a = collect(first);
    // A watch that does not end by itself is killed after 5 s, so a regression fails here and does not hang the suite.
    const timer = setTimeout(() => first.kill("SIGKILL"), 5000);
    const code = await new Promise((res) => first.on("close", (c, sig) => res(sig ? `killed by ${sig}: the stale watch did not end` : c)));
    clearTimeout(timer);
    assert.equal(code, 0);
    assert.match(a.out, /^wake-watch: stale pin: this watch runs from install 11111111aaaa but the Stop hook pins 22222222bbbb/, a.err);
    assert.equal(existsSync(join(r.dir, dispatchPidFile("Builder"))), false, "its pid file goes with it");
    const again = r.start(), b = collect(again);
    await new Promise((res) => setTimeout(res, 900));
    assert.equal(again.exitCode, null, "the same stale path again is told once: it keeps running");
    assert.equal(b.out, "");
    assert.equal(existsSync(join(r.dir, dispatchPidFile("Builder"))), true, "running, with its beat");
    again.kill("SIGTERM");
    await new Promise((res) => again.on("close", res));
  } finally { rmSync(r.home, { recursive: true, force: true }); }
  const ok = await run(OLD);
  try {
    const child = ok.start(), c = collect(child);
    await new Promise((res) => setTimeout(res, 900));
    assert.equal(child.exitCode, null, "on the pin: it keeps running");
    assert.equal(c.out, "");
    child.kill("SIGTERM");
    await new Promise((res) => child.on("close", res));
  } finally { rmSync(ok.home, { recursive: true, force: true }); }
});

// #C1159: the stale check goes before the dispatch, and the DISPATCH tag is added where the line is printed.
const NOW = 1_800_000_000_000;
test("watchLook: a stale watch ends with the stale line BEFORE it decides a dispatch: the card is not marked printed and no pid beat is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "stale-look-"));
  try {
    writeFileSync(join(dir, DISPATCH_FILE), JSON.stringify({ at: NOW, items: [{ card: "menu", role: "Builder", level: 1, since: NOW }] }));
    const got = watchLook(dir, "Builder", OLD, settings(NEW), NOW, 4242);
    assert.deepEqual(got, { line: staleLine(OLD, NEW), stale: true });
    assert.equal(existsSync(join(dir, dispatchSeenFile("Builder"))), false, "the old code did not mark the card printed");
    assert.equal(existsSync(join(dir, dispatchPidFile("Builder"))), false, "nor beat the pid file");
    // the re-armed watch on the pin decides it
    const next = watchLook(dir, "Builder", NEW, settings(NEW), NOW + 1000, 4243);
    assert.equal(next.stale, false);
    assert.match(next.line, /^DISPATCH menu: it waits on you \(Builder\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("watchLook: every DISPATCH line it returns carries the watch's install tag (at the print site); a watch outside an install folder adds none; nothing due is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "stale-look-"));
  try {
    const put = (items) => writeFileSync(join(dir, DISPATCH_FILE), JSON.stringify({ at: NOW, items }));
    put([]);
    assert.equal(watchLook(dir, "Builder", NEW, settings(NEW), NOW), null);
    put([{ card: "menu", role: "Builder", level: 1, since: NOW }]);
    const got = watchLook(dir, "Builder", NEW, settings(NEW), NOW + 1000);
    assert.match(got.line, /^DISPATCH menu: .*\[watch install 22222222bbbb\]$/);
    put([{ card: "menu", role: "Builder", level: 1, since: NOW + 50 * 60e3 }]);
    const plain = watchLook(dir, "Builder", null, settings(NEW), NOW + 51 * 60e3);
    assert.match(plain.line, /^DISPATCH menu: /);
    assert.doesNotMatch(plain.line, /watch install/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
